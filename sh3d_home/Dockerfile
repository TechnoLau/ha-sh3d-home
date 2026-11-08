ARG BUILD_FROM=python:3.12-alpine3.20
FROM ${BUILD_FROM}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    SH3D_DATA_DIR=/data \
    SH3D_CONFIG_WWW=/config/www \
    SH3D_SCAN_DIRS=/share/sh3d-home,/share,/media,/config/www \
    PORT=8099

RUN apk add --no-cache tzdata curl
WORKDIR /app
COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt
COPY app /app/app

EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fsS http://127.0.0.1:8099/api/health || exit 1
CMD ["python3", "-m", "app.main"]
