# Detector API, deployed to Google Cloud Run (Deploy from repository,
# build type Dockerfile) for the submission's Production URL. Render's free
# tier OOMs on sentence-transformers (512MB isn't enough); HF Spaces' free
# tier turned out Docker-SDK-only-on-PRO. Cloud Run's Always Free tier
# (2M requests/mo, 360k GiB-seconds/mo) covers demo-level traffic at $0 with
# 1GiB configured per instance. Local installs don't use this file at all.
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
