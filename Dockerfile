# Detector API, for Hugging Face Spaces (Docker SDK) — Render's free tier
# doesn't have enough RAM for sentence-transformers; HF Spaces' free CPU
# tier gives 16GB, which does. Local installs don't use this at all.
FROM python:3.11-slim

WORKDIR /app

# Prebuilt CPU wheels cover torch/sentence-transformers on this base image,
# so no extra build toolchain is needed here.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# HF Spaces' Docker runtime expects the app on 7860 by default.
ENV NDAI_HOST=0.0.0.0
ENV PORT=7860
EXPOSE 7860

CMD ["python", "-m", "detector.main"]
