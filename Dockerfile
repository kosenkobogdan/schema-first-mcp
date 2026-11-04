FROM node:22-bookworm-slim AS whisper
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper \
  && cmake -S /tmp/whisper -B /tmp/whisper/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
  && cmake --build /tmp/whisper/build --target whisper-cli -j"$(nproc)" \
  && mkdir -p /out/bin /out/lib \
  && find /tmp/whisper/build -type f -name whisper-cli -executable -exec cp {} /out/bin/whisper-cli \; \
  && find /tmp/whisper/build -type f \( -name 'libwhisper.so*' -o -name 'libggml*.so*' \) -exec cp -a {} /out/lib \;

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /out/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /out/lib/ /usr/local/lib/
RUN ldconfig
RUN mkdir -p /models \
  && curl -fsSL -o /models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV DATA_DIR=/tmp/schema-first
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/models/ggml-tiny.bin
EXPOSE 8787
CMD ["node", "src/index.js"]
