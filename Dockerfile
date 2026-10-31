# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 VC_DATA_DIR=/var/lib/yengolf
WORKDIR /app
COPY requirements.txt ./
# Optional session CA mount for managed-cloud builds; normal hosting uses system trust.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
RUN groupadd --gid 10001 yengolf && useradd --uid 10001 --gid yengolf --no-create-home yengolf \
    && mkdir -p /var/lib/yengolf && chown yengolf:yengolf /var/lib/yengolf
COPY --chown=yengolf:yengolf server.py qr_codes.py ./
COPY entrypoint.sh /usr/local/bin/yengolf-entrypoint
RUN chmod 0755 /usr/local/bin/yengolf-entrypoint
COPY --chown=yengolf:yengolf static ./static
COPY --chown=yengolf:yengolf data ./data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"
ENTRYPOINT ["/usr/local/bin/yengolf-entrypoint"]
CMD ["python", "server.py", "--host", "0.0.0.0"]
