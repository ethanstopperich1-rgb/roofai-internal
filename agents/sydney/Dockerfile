FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Audio + ML deps (Silero VAD needs libgomp)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

# Pre-warm Silero VAD + multilingual turn detector into the image so
# cold-start doesn't pay the network round-trip + download.
RUN python -c "from livekit.plugins import silero; silero.VAD.load()" || true
RUN python -c "from livekit.plugins.turn_detector.multilingual import MultilingualModel; MultilingualModel()" || true

COPY agent.py tools.py events.py setup_sip.py ./
COPY prompts/ ./prompts/

CMD ["python", "agent.py", "start"]
