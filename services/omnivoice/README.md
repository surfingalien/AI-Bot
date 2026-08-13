# OmniVoice, as something the desk can call

[OmniVoice](https://github.com/k2-fsa/OmniVoice) is a zero-shot TTS model
covering 600+ languages, with voice cloning and voice design. It ships a Python
API, two CLI tools and a Gradio demo — and no HTTP endpoint. `server.py` is that
endpoint, and nothing more.

## Why this exists

The desk used to speak through the browser's own synthesiser. On a machine with
no voices installed that produces **nothing at all**: no sound, no error, and no
client-side fix — the failure is below the code. Audio synthesised on a server
has no such failure, because playing a sound file is the one thing every browser
can do.

## What it needs

A GPU. The upstream RTF of 0.025 is measured on a single H100 in fp16. `DEVICE=cpu`
runs and is fine for a smoke test, but this is a diffusion model — on CPU a
spoken brief arrives long after it was worth hearing.

This is why it is a separate service rather than part of the desk's container:
that image is a small Node runtime on a CPU box, and PyTorch plus multi-gigabyte
weights do not belong in it.

## Running it

```bash
pip install omnivoice fastapi uvicorn soundfile
# plus torch for your platform — see the OmniVoice README

DEVICE=cuda:0 uvicorn server:app --host 0.0.0.0 --port 8080
```

Weights download from HuggingFace on first request. `/health` answers before
they are loaded, so a probe never blocks on a cold start.

Then point the desk at it:

```bash
TTS_BASE=http://<this-host>:8080
```

The desk advertises the capability through `/api/config`, and the browser starts
asking for audio instead of using its own voices. Nothing else changes: the
briefing, the instant lead, barge-in and the sentence-at-a-time streaming all
work exactly as before — only the last mile is different.

## Choosing a voice

Two ways, and cloning is the better one — the model is trained primarily for it.

**Voice design** needs no audio. Set attributes and go:

```bash
OMNIVOICE_INSTRUCT="female, low pitch, british accent"
```

Trained on Chinese and English only, so it may be unstable in other languages.

**Voice cloning** needs 3–10 seconds of reference audio, encoded once:

```python
from omnivoice import OmniVoice
model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0")
prompt = model.create_voice_clone_prompt(ref_audio="ref.wav", ref_text="…")
prompt.save("desk_voice.pt")
```

```bash
OMNIVOICE_VOICE_PROMPT=/models/desk_voice.pt
```

A configured clone prompt wins over attributes.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DEVICE` | `cuda:0` | `cuda:0`, `mps`, `xpu`, or `cpu` |
| `OMNIVOICE_MODEL` | `k2-fsa/OmniVoice` | HuggingFace model id |
| `OMNIVOICE_INSTRUCT` | — | Voice design attributes |
| `OMNIVOICE_VOICE_PROMPT` | — | Path to a saved clone prompt |
| `OMNIVOICE_STEPS` | `32` | Diffusion steps; fewer is faster and thinner |
| `OMNIVOICE_MAX_CHARS` | `600` | Refuses longer input — the desk sends sentences |

Every response logs its real-time factor. Above 1.0 the model is slower than the
speech it produces, which for an interactive desk means it is the wrong device
or too many steps.

## The contract

Two endpoints, and any service implementing them can replace this one — the desk
knows nothing about OmniVoice specifically.

```
GET  /health  -> {"ok": true, ...}
POST /speak   -> audio/wav
     {"text": "...", "instruct": "...", "voice": "..."}
```

`instruct` and `voice` are hints. A backend that does not understand them should
ignore them rather than fail.
