ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}

ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PYPI_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

WORKDIR /app

ENV ASTRBOT_ROOT=/app \
    PIP_INDEX_URL=${PYPI_INDEX_URL} \
    PYTHONPATH=/app/AstrBot \
    TZ=Asia/Shanghai \
    UV_DEFAULT_INDEX=${PYPI_INDEX_URL}

RUN sed -i -E "s#https?://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR%/}#g" /etc/apk/repositories \
    && apk add --no-cache \
    bash \
    build-base \
    ca-certificates \
    cargo \
    curl \
    ffmpeg \
    git \
    libffi-dev \
    openssl-dev \
    py3-pip \
    py3-virtualenv \
    python3 \
    python3-dev \
    ripgrep \
    tzdata

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm config set replace-registry-host always \
    && npm ci --omit=dev

COPY AstrBot ./AstrBot
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir --upgrade pip uv \
    && /app/.venv/bin/uv pip install \
        --python /app/.venv/bin/python \
        --no-cache \
        -r /app/AstrBot/requirements.txt \
    && /app/.venv/bin/uv pip install \
        --python /app/.venv/bin/python \
        --no-cache \
        socksio uv pilk

COPY src ./src

EXPOSE 6185 6190 6191

CMD ["npm", "start"]
