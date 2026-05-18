# Multi-stage: build the Vite bundle, then serve it via Streamlit wrapper.
# Run: docker compose up --build -d

FROM node:20-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build \
    && test -f dist/index.html \
    && test "$(find dist/assets -name '*.js' | wc -l)" -ge 1

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p .streamlit
COPY .streamlit/config.toml .streamlit/config.toml

COPY streamlit_app.py .
COPY --from=frontend /src/dist ./dist

# Default 8501 for local Docker Compose; Railway injects $PORT at runtime.
EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import os,urllib.request as u; p=os.environ.get('PORT','8501'); u.urlopen(f'http://127.0.0.1:{p}/_stcore/health', timeout=5).read()"

SHELL ["/bin/sh", "-c"]
CMD exec streamlit run streamlit_app.py --server.address=0.0.0.0 --server.port="${PORT:-8501}"
