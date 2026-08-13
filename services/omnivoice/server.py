"""An HTTP front door for OmniVoice, because upstream does not ship one.

k2-fsa/OmniVoice gives you a Python API, two CLI entry points and a Gradio
demo. None of those is something a Node server can point a URL at, so this is
the missing piece: load the model once, answer POST /speak with a WAV.

It is deliberately small. Everything about *what* to say already lives in the
desk — shaping, briefing, sentence splitting, barge-in. This only turns a
sentence into a sound.

Run it on something with a GPU. The paper's RTF of 0.025 is measured on an
H100 in fp16; on CPU this model is far slower than real time and a spoken brief
would arrive long after it mattered. `DEVICE=cpu` works and is useful for a
smoke test, not for a desk someone is waiting on.

    pip install "omnivoice" fastapi uvicorn soundfile
    DEVICE=cuda:0 uvicorn server:app --host 0.0.0.0 --port 8080

Then on the desk's server:

    TTS_BASE=http://<this-host>:8080
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
DEVICE = os.environ.get("DEVICE", "cuda:0")
# fp16 on a GPU, fp32 on CPU — half precision on CPU is slower, not faster.
DTYPE = torch.float16 if DEVICE.startswith(("cuda", "xpu")) else torch.float32
# The sample rate OmniVoice generates at.
SAMPLE_RATE = 24000
# A shared voice for every brief, unless a request overrides it. Voice design
# attributes: "female, low pitch, british accent".
DEFAULT_INSTRUCT = os.environ.get("OMNIVOICE_INSTRUCT", "")
# A saved voice-clone prompt (model.create_voice_clone_prompt(...).save(path)).
# Cloning is the mode this model is strongest at, so a prompt beats attributes
# when you have one.
VOICE_PROMPT_PATH = os.environ.get("OMNIVOICE_VOICE_PROMPT", "")
# Diffusion steps. Fewer is faster and thinner; the upstream benchmark uses 32.
NUM_STEP = int(os.environ.get("OMNIVOICE_STEPS", "32"))
# Long input is a runaway prompt, not a briefing. The desk sends sentences.
MAX_CHARS = int(os.environ.get("OMNIVOICE_MAX_CHARS", "600"))

log = logging.getLogger("omnivoice-service")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="OmniVoice for the desk", version="1.0")

_model = None
_prompt = None
# Generation is not thread-safe and a GPU is one resource anyway. Serialising
# here keeps a burst of streamed sentences from fighting over it.
_lock = threading.Lock()


def model():
    """Load once, on first use, so the port is listening while weights arrive."""
    global _model, _prompt
    if _model is not None:
        return _model

    with _lock:
        if _model is not None:
            return _model
        log.info("loading %s onto %s (%s)", MODEL_ID, DEVICE, DTYPE)
        started = time.time()
        from omnivoice import OmniVoice

        _model = OmniVoice.from_pretrained(MODEL_ID, device_map=DEVICE, dtype=DTYPE)
        if VOICE_PROMPT_PATH:
            from omnivoice import VoiceClonePrompt

            _prompt = VoiceClonePrompt.load(VOICE_PROMPT_PATH)
            log.info("loaded voice clone prompt from %s", VOICE_PROMPT_PATH)
        log.info("model ready in %.1fs", time.time() - started)
        return _model


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1)
    # Both optional and both hints: the desk sends whatever it has configured
    # and does not care which one this service honours.
    instruct: str | None = None
    voice: str | None = None


@app.get("/health")
def health():
    """Answers before the weights are loaded, so a probe never blocks on them."""
    return {
        "ok": True,
        "model": MODEL_ID,
        "device": DEVICE,
        "loaded": _model is not None,
        "sample_rate": SAMPLE_RATE,
    }


@app.post("/speak")
def speak(req: SpeakRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"text over {MAX_CHARS} characters")

    kwargs = {"text": text, "num_step": NUM_STEP}
    # A cloned voice is the model's strongest mode, so it wins when configured.
    # Otherwise fall back to voice design, which needs no reference audio.
    if _prompt is not None and not req.voice:
        kwargs["voice_clone_prompt"] = _prompt
    else:
        instruct = req.instruct or DEFAULT_INSTRUCT
        if instruct:
            kwargs["instruct"] = instruct

    started = time.time()
    try:
        with _lock:
            audio = model().generate(**kwargs)
    except Exception as err:  # noqa: BLE001 - the caller needs the reason, whatever it is
        log.exception("generation failed")
        raise HTTPException(status_code=502, detail=str(err)) from err

    if not len(audio):
        raise HTTPException(status_code=502, detail="model returned no audio")

    buf = io.BytesIO()
    sf.write(buf, audio[0], SAMPLE_RATE, format="WAV", subtype="PCM_16")
    wav = buf.getvalue()

    took = time.time() - started
    seconds = len(audio[0]) / SAMPLE_RATE
    # The number that decides whether this is usable for a desk someone is
    # waiting on. Above 1.0 it is slower than real time.
    log.info("%.2fs audio in %.2fs (RTF %.3f)", seconds, took, took / max(seconds, 1e-6))

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Generation-Seconds": f"{took:.2f}"},
    )
