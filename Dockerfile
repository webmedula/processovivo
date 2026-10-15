# Node 24: `node:sqlite` (banco embutido) é estável a partir dele, sem flag.
# Evita `better-sqlite3`, que exigiria python/make/g++ no estágio de build.
#
# Build multi-stage: as devDependencies (TypeScript, Vitest, ESLint) existem só
# no estágio de build. A imagem final leva o JS compilado e as dependências de
# produção — nada de código-fonte, nada de compilador.
#
# No Easypanel, escolha o builder "Dockerfile" e aponte para este arquivo.

# ---------------------------------------------------------------------------
# 1. Dependências (camada cacheada: só refaz quando package*.json mudam)
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` (e não `install`) porque o lockfile é a fonte da verdade: build
# reproduzível, e uma dependência transitiva não muda sozinha entre um deploy
# e outro.
RUN npm ci

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# 3. Dependências de produção apenas
# ---------------------------------------------------------------------------
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# 4. Runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000 \
    PROCESSOVIVO_DB_PATH=/dados/processovivo.db

# `--init` no docker run resolveria isso, mas o Easypanel não expõe essa flag.
# O tini garante que SIGTERM chegue ao Node em vez de morrer no PID 1, que é o
# que faz um redeploy derrubar requisições em voo.
RUN apk add --no-cache tini

# Leitor de peças (v0.30.0). `qpdf` junta os PDFs do processo num só lendo por
# partes, em outro processo: medido com 280 PDFs/160 MB, pico de 37 MB, contra
# +357 MB fazendo o mesmo com pdf-lib dentro do Node. Sem ele o leitor não sobe
# (a rota responde 501 dizendo o que falta).
# `poppler-utils` (pdftotext/pdfinfo) entra JÁ na 0.30.0 por decisão do dono:
# é o que mede a camada de texto dos PDFs, que decide se a análise vai precisar
# de OCR. O leitor ainda não o usa.
RUN apk add --no-cache qpdf poppler-utils

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts
# Casos SINTÉTICOS (inventados) da sonda de IA do ato: `scripts/sonda-ia-ato.mjs` os lê.
# Não há dado real aqui; só texto de teste.
COPY tests/fixtures/ia-ato ./tests/fixtures/ia-ato

# Diretório do banco, criado ANTES de trocar de usuário e com dono `node` —
# senão o processo sobe sem permissão de escrever e quebra na primeira gravação.
# No Easypanel, monte um VOLUME em /dados: sem isso, os acompanhamentos e o
# histórico de novidades somem a cada redeploy.
#
# A guarda temporária do leitor fica em /dados/leitor (ao lado do banco, no
# volume, FORA do backup — o backup copia o banco, não a pasta). Criada aqui
# pelo mesmo motivo de /dados: dono `node` antes de trocar de usuário.
RUN mkdir -p /dados/leitor && chown -R node:node /dados
VOLUME ["/dados"]

# A imagem base já traz o usuário `node` (UID 1000). Rodar como root dentro do
# contêiner não é necessário aqui e amplia o estrago de qualquer RCE.
USER node

EXPOSE 3000

# Bate no /health, que de propósito NÃO consulta os tribunais: se consultasse,
# instabilidade do TJSP faria o Docker reiniciar um contêiner saudável.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main/http/index.js"]
