# Deploy do Processo Vivo no Easypanel

Runbook do zero até a API respondendo no seu domínio. Se algo falhar, a seção
[Quando der errado](#quando-der-errado) cobre os tropeços mais comuns.

---

## 0. Antes de começar

- VPS com Easypanel instalado e acessível
- Repositório no GitHub com este código (público ou privado)
- Um subdomínio apontado para o IP do VPS — ex.: `processovivo.webmedula.com.br`,
  registro **A** → IP do VPS
- (Opcional) Chave Pública do DataJud:
  <https://datajud-wiki.cnj.jus.br/api-publica/acesso/>

Sem a chave do DataJud o serviço sobe igual — só roda com o crawler mock, o que
é suficiente para validar o deploy inteiro.

---

## 1. Gere as chaves de API

O serviço **se recusa a subir sem `PROCESSOVIVO_API_KEYS`**, e também recusa chave com
menos de 24 caracteres. Isso é proposital: a API do DataJud usa uma Chave Pública
compartilhada do CNJ, e um endpoint aberto na internet transforma seu VPS em
proxy gratuito para a cota de todo mundo — o bloqueio cai sobre a chave, não
sobre quem abusou.

### O que essa chave é (e o que não é)

Não é algo emitido por ninguém, nem tem relação com a chave do CNJ. É **um
segredo aleatório que você inventa**, e o Processo Vivo compara com o que chega no
header `x-api-key`. Quem tem a string entra; quem não tem, não. Só isso.

O que importa é que seja **aleatória de verdade** e **longa o bastante**. O
padrão do projeto é 32 bytes (256 bits) em hexadecimal — 64 caracteres. Não
existe força bruta viável contra isso.

Duas coisas que parecem chave e não são: senha que você inventou de cabeça
(previsível) e `Math.random()` (não é criptográfico — algumas saídas revelam o
gerador). Use sempre um gerador criptográfico do sistema.

### Como gerar

**Pelo próprio projeto (funciona em Windows, Linux e Mac):**

```bash
npm run chave
```

```
  chave 1
    valor .......... 5f0eb8d08f4889fdb46ece84fc4187bd4260e010702897a731e9b11a4632888a
    identificador .. 3ca36306
```

O **identificador** é o hash curto que aparece nos logs. Anote-o ao lado do nome
do consumidor ("3ca36306 = n8n") — assim, meses depois, você lê uma linha de log
e sabe de qual integração veio a requisição, sem nunca ter anotado a chave em
lugar nenhum além do gerenciador de senhas.

Variações:

```bash
npm run chave -- --rotulo n8n     # com nome, para não se perder
npm run chave -- 3                # três chaves de uma vez
npm run chave -- 3 --env          # já no formato PROCESSOVIVO_API_KEYS=a,b,c
```

**Sem o projeto em mãos, só com o Node instalado:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**PowerShell puro (Windows, sem Node):**

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
-join ($b | ForEach-Object { $_.ToString('x2') })
```

**Git Bash, WSL, Linux ou Mac:**

```bash
openssl rand -hex 32
```

**Direto no VPS, via SSH** — útil quando você já está lá configurando:

```bash
openssl rand -hex 32
```

### Quantas chaves criar

Uma **por consumidor**, não uma para tudo. Separe pelo menos:

| Consumidor | Para quê |
|---|---|
| `seu-uso` | testes manuais, `curl`, Postman |
| `n8n` | seus fluxos de automação |
| `<cliente>` | cada integração externa, se houver |

O motivo é revogação: se a chave do n8n vazar num log ou num print, você tira
**só ela** da variável e redeploya. Com chave única compartilhada, revogar uma
significa derrubar todo mundo ao mesmo tempo.

No `PROCESSOVIVO_API_KEYS` elas vão separadas por vírgula:

```env
PROCESSOVIVO_API_KEYS=5f0eb8d0...888a,03a5babf...6ec2,5f3ae83a...e38d3
```

Espaços em volta das vírgulas são tolerados. Chaves repetidas são recusadas no
arranque — repetir anula o motivo de ter várias.

### Onde guardar

- **Gerenciador de senhas** (Bitwarden, 1Password, KeePass) — é a cópia oficial.
  O script não salva nada em disco; fechou o terminal, a chave se foi.
- **Easypanel → aba Environment** — é onde o serviço lê. Trate como segredo:
  não imprima em log de build, não cole em issue, não mande por WhatsApp.
- **Nunca no Git.** O `.gitignore` já barra o `.env`, mas confira antes do
  primeiro push. Chave que entrou no histórico do Git continua lá mesmo depois
  de você apagar o arquivo num commit seguinte — nesse caso, gere outra.

### Rotação, sem derrubar ninguém

Troca periódica (ou vazamento) sem janela de indisponibilidade:

1. Gere a chave nova: `npm run chave -- --rotulo n8n-nova`
2. No Easypanel, **acrescente** a nova à lista, mantendo a antiga:
   `PROCESSOVIVO_API_KEYS=<antiga>,<nova>`
3. Redeploy. Agora as duas funcionam.
4. Atualize o consumidor (n8n, script, cliente) para usar a nova.
5. Confirme nos logs que o identificador antigo parou de aparecer.
6. Remova a antiga da lista e redeploye de novo.

Se a chave **vazou**, pule a gentileza: tire a comprometida na hora e redeploye.
Alguns minutos de erro no consumidor legítimo custam menos que uma chave viva na
mão de terceiro.

---

## 2. Suba o código para o GitHub

> **Já subiu uma versão antes?** Pule para
> [Atualizando de uma versão anterior](#atualizando-de-uma-versão-anterior),
> no fim deste documento — tem uma armadilha do upload pelo navegador que
> precisa ser checada.

```bash
cd processovivo
git init
git add .
git commit -m "Processo Vivo: núcleo, API HTTP e Docker"
git branch -M main
git remote add origin git@github.com:SEU-USUARIO/processovivo.git
git push -u origin main
```

O `.gitignore` já barra `.env`, `node_modules/` e `dist/`. **Confira que o
`.env` não subiu** — se subiu, considere as chaves queimadas e gere outras.

---

## 3. Crie o serviço no Easypanel

No painel: **Projeto → + Service → App**. Nome: `processovivo-api`.

### Aba Source

| Campo | Valor |
|---|---|
| Type | GitHub |
| Repository | `SEU-USUARIO/processovivo` |
| Branch | `main` |
| Build Path | `/` |

Repositório privado exige conectar a conta do GitHub ao Easypanel antes (o
painel guia isso na própria aba).

### Aba Build

| Campo | Valor |
|---|---|
| Method | **Dockerfile** |
| File | `Dockerfile` |

Nixpacks também detectaria o projeto, mas o Dockerfile é a escolha certa aqui:
ele fixa Node 22, faz o build multi-stage (a imagem final não leva TypeScript
nem Vitest), roda como usuário não-root e trata SIGTERM via tini. Com Nixpacks
você fica na mão da heurística de detecção — e ela muda entre versões.

### Aba Environment

Cole isto **como está** e depois preencha só a linha do `PROCESSOVIVO_API_KEYS` com a
chave do passo 1:

```env
NODE_ENV=production
HTTP_HOST=0.0.0.0
HTTP_PORT=3000

# ↓ cole aqui a chave gerada no passo 1 (npm run chave)
PROCESSOVIVO_API_KEYS=
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000
HTTP_TRUST_PROXY=true

PROCESSOVIVO_PROVIDER_CHAIN=datajud,djen
# Deixe vazia até ter a Chave Pública do CNJ. Vazia = o DataJud sai da cadeia
# e o serviço roda só com o DJEN, sem erro — e o DJEN não precisa de chave.
DATAJUD_API_KEY=
DATAJUD_RATE_LIMIT_PER_MINUTE=60
# DJEN: nenhuma credencial. É o diário oficial, aberto por desenho.
DJEN_RATE_LIMIT_PER_MINUTE=60
DJEN_MAX_COMUNICACOES_POR_OAB=500

# Vigilância por OAB: de hora em hora, porque só toca o DJEN.
VIGILANCIA_INTERVALO_HORAS=1
VIGILANCIA_MAXIMO_POR_VARREDURA=50

# Aviso por e-mail. Vazio = modo log (o resumo aparece no log, nada é enviado).
#
# SMTP_HOST + PROCESSOVIVO_URL_BASE também ligam a RECUPERAÇÃO DE SENHA. Sem os
# dois, a tela de entrada não mostra o "esqueci minha senha" — e a única saída
# de quem perder a senha é você, no banco. Configure antes do primeiro cliente.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
# Endereço público do sistema. Sai nos links dos e-mails, inclusive o de
# redefinir senha. Vem DAQUI e não do cabeçalho Host da requisição: senão
# bastaria mandar outro Host para o servidor enviar, com a nossa cara, um link
# apontando para o endereço de quem atacou.
#
# Aponta para o SUBDOMÍNIO do app, não para a raiz: a raiz é a página de vendas.
# Errar aqui manda quem clicou em "redefinir senha" para a landing, que não sabe
# o que fazer com o token.
PROCESSOVIVO_URL_BASE=https://app.processovivo.com.br

# --- Peças do processo (v0.12.0) -------------------------------------------
# Cifra a senha do advogado no tribunal. Gere com: npm run chave -- --cofre
# VAZIA = acesso a peças desligado, e as rotas respondem 501 com a instrução.
# Não existe caminho que guarde senha de tribunal em claro.
#
# NUNCA troque esta chave depois de cadastrar credenciais: o que está no banco
# foi cifrado com a antiga e vira ilegível, obrigando cada assinante a cadastrar
# a senha do tribunal de novo.
PROCESSOVIVO_CREDENCIAL_CHAVE=
MNI_ENDPOINT=https://projudi.tjgo.jus.br/IntercomunicacaoService
MNI_TRIBUNAIS=TJGO
MNI_TIMEOUT_MS=90000
MNI_RATE_LIMIT_PER_MINUTE=30

CACHE_ENABLED=true
CACHE_TTL_SECONDS=900

# Banco: precisa apontar para o volume montado em /dados
PROCESSOVIVO_DB_PATH=/dados/processovivo.db
# Varredura automática dos processos acompanhados. 0 desliga.
SYNC_INTERVALO_HORAS=12
SYNC_PAUSA_MS=1500
# Quantos processos são verificados ao mesmo tempo (v0.49.3). Padrão 3, máximo 4; 1 = um por vez (como antes).
# Valor inválido (zero, negativo, texto, acima de 4) NÃO derruba o serviço: usa 3 e registra um aviso no arranque.
# Não altera o limite de requisições por fonte (DATAJUD_RATE_LIMIT_PER_MINUTE etc.): só tira a espera ociosa.
# SYNC_PAUSA_MS vale por trabalhador, depois de cada processo.
SYNC_CONCORRENCIA=3

# Backup automático do banco. Ligado por padrão; 0 desliga.
# As cópias vão para /dados/backups — dentro do MESMO volume. Leia a seção
# "6. Backup, restauração e custódia da chave" antes de considerar isso pronto.
BACKUP_INTERVALO_HORAS=24
BACKUP_MANTER=7

LOG_LEVEL=info
```

**Saída de rede exigida pelo contêiner:** `api-publica.datajud.cnj.jus.br`,
`comunicaapi.pje.jus.br` e — a partir da v0.12.0 — `projudi.tjgo.jus.br`.

**Atenção ao IP do VPS.** O MNI bloqueia IP de datacenter quando o volume de
requisições sobe: responde 403 e a espera é da ordem de 30 minutos. Como o IP é
o mesmo para todos os assinantes, um pico derruba o acesso de todo mundo junto —
por isso `MNI_RATE_LIMIT_PER_MINUTE` vem em 30, metade do teto relatado. Não
aumente sem necessidade.

**Leitor de peças (v0.30.0).** Depois de um 403 o MNI inteiro fica parado por
`MNI_PAUSA_APOS_403_MIN` (30): peça avulsa, régua e leitor, de todos os
assinantes. Os PDFs combinados ficam em `/dados/leitor` (no volume, apagados
depois de `LEITOR_TTL_HORAS`, 24 h). A imagem já traz `qpdf` e `poppler-utils`;
sem o `qpdf` o leitor não sobe e o log diz por quê. O uso de disco do leitor vai
para o log a cada PDF montado e a cada limpeza (`leitor: uso de disco`).

> **Não escreva um texto de exemplo no lugar de um valor que você ainda não tem.**
> Uma variável com `COLE_AQUI_...` dentro não está vazia: o serviço a aceita como
> credencial e só falha depois, na primeira chamada — longe da causa. A partir da
> v0.4.1 o Processo Vivo detecta esses textos e avisa, mas o hábito certo é deixar a
> linha vazia mesmo.

### Aba Mounts — **obrigatório a partir da v0.8.0**

O Processo Vivo agora guarda os processos acompanhados e o histórico de novidades num
arquivo SQLite. Sem um volume, esse arquivo vive dentro do contêiner e **é
apagado a cada redeploy** — o usuário perde a carteira inteira e o histórico de
"o que mudou".

Em **Mounts → Add Mount**:

| Campo | Valor |
|---|---|
| Type | **Volume** |
| Name | `processovivo-dados` |
| Mount Path | `/dados` |

O `Dockerfile` já define `PROCESSOVIVO_DB_PATH=/dados/processovivo.db` e cria o diretório
com o dono certo. Você só precisa montar o volume.

Para conferir depois do deploy: acompanhe um processo, faça um **Deploy** de
novo e veja se ele continua na lista. Se sumiu, o volume não está montado.

### Aba Domains

O sistema vive no **subdomínio**, e a raiz do domínio fica para a página de
vendas:

| Campo | Valor |
|---|---|
| Host | `app.processovivo.com.br` |
| Path | `/` |
| Protocol | HTTP |
| **Port** | **3000** |
| HTTPS | ligado (Let's Encrypt) |

**A porta alvo tem que ser 3000** — é onde o contêiner escuta. Esse é o campo
que mais gera "502 Bad Gateway" quando fica errado.

No DNS do domínio, um registro **A** para `app` apontando para o IP do VPS. O
Let's Encrypt só emite o certificado depois que o DNS propagar, então um erro de
certificado nos primeiros minutos é espera, não defeito.

**Por que o app não fica na raiz.** Separar custa um serviço a mais no Easypanel
e paga em três coisas: a landing pode receber pixel de anúncio, Google Analytics
e script de terceiro sem que nada disso encoste na página onde o advogado digita
a senha; a landing pode cair, ser reescrita ou trocar de tecnologia sem risco
para o sistema; e `PROCESSOVIVO_URL_BASE` aponta para um endereço que não vai
mudar — os links dos e-mails de recuperação de senha, que valem uma hora, não
podem apontar para um lugar que você planeja reformar.

Quando a landing existir, ela entra como um segundo serviço, com Host
`processovivo.com.br` e `www.processovivo.com.br`.

### Deploy

Botão **Deploy**. Acompanhe o log de build: as quatro etapas do Dockerfile
(deps → build → prod-deps → runtime) aparecem nomeadas.

---

## 4. Confirme que subiu

```bash
# Liveness — não deve pedir chave
curl https://processovivo.webmedula.com.br/health
# {"status":"ok","uptimeSegundos":12}

# Readiness — mostra o estado de cada fonte
curl https://processovivo.webmedula.com.br/ready
# {"status":"pronto","fontes":[{"provider":"mock-crawler-tjsp","saudavel":true},…]}

# Consulta de verdade
curl -H "x-api-key: SUA_CHAVE" \
  https://processovivo.webmedula.com.br/v1/processos/1234567-47.2023.8.26.0100

# A carteira de um advogado
curl -H "x-api-key: SUA_CHAVE" \
  https://processovivo.webmedula.com.br/v1/advogados/SP/234567/processos

# Sem chave deve dar 401 — se der 200, a autenticação não está ativa
curl -i https://processovivo.webmedula.com.br/v1/processos/1234567-47.2023.8.26.0100
```

---

## 5. Deploy contínuo

Com a fonte GitHub configurada, o Easypanel expõe um **webhook de deploy**
(aba Source, "Deploy Webhook"). Cole a URL em
`GitHub → Settings → Webhooks → Add webhook`, content type
`application/json`. A partir daí, todo push na `main` redeploya sozinho.

O `.github/workflows/ci.yml` roda typecheck, lint, testes e o build da imagem em
cada push. Vale proteger a branch `main` exigindo o CI verde — assim um deploy
quebrado não chega ao VPS.

---

## 6. Backup, restauração e custódia da chave

Esta seção é a que separa "está no ar" de "dá para vender". A partir do momento
em que existe um assinante, o banco do Processo Vivo guarda a carteira de processos
dele, o histórico de novidades e a credencial dele no tribunal. Perder isso não
é um incidente técnico: é o cliente sem o próprio trabalho.

> **`/dados/leitor` fica FORA do backup, de propósito.** São PDFs de autos de
> processo guardados por 24 h, refeitos sob demanda — o combinado do leitor e,
> desde a v0.33.0, cada peça aberta pela Pasta digital (a mesma pasta, a mesma
> cota por conta). Uma pasta completa ocupa o dobro do PDF combinado em disco. O backup automático copia
> só o banco; se você copiar o volume inteiro à mão, exclua `leitor/`
> (`rsync --exclude leitor/`). Restaurar um backup não traz PDFs de volta, e
> não precisa: os jobs aparecem como expirados e o advogado pede de novo.

> **Os custos do processo (v0.47.0, ampliados na v0.48.0) estão no backup, com o histórico e os cancelados.** Os
> lançamentos (`custos_processo`), os recebimentos do cliente (`recebimentos_processo`), as subcategorias próprias
> (`categorias_custo`), o histórico de alterações (`historico_custos`, somente de acréscimo) e, desde a v0.49.0, o
> vínculo dos comprovantes (`comprovantes_custo`: só o id do arquivo no Drive, o link, o nome, o tamanho e a data;
> **o arquivo em si mora no Google Drive do advogado e NÃO está no servidor nem no backup**) moram no mesmo banco SQLite e entram no `VACUUM INTO` como qualquer outro dado:
> restaurar um backup devolve os custos junto com a carteira. **Lançamentos e recebimentos cancelados NÃO são
> apagados:** ficam guardados, junto com o histórico, enquanto a conta existir — só a exclusão da conta os leva. A
> migração da 0.48.0 roda sozinha no primeiro arranque (marca `migracao:custos-0.48.0` na tabela `estado`) e é
> idempotente; tire uma cópia do banco antes do primeiro deploy da versão. **A 0.49.0 não tem migração de dados**
> (só a tabela nova `comprovantes_custo`, criada sozinha) e **não tem variável de ambiente nova**: anexar comprovante
> usa a integração do Drive que já existe e só funciona com `PROCESSOVIVO_DRIVE_HABILITADO=true`, o Drive conectado
> pelo advogado e um plano com `salvarNoDrive`. O PDF consolidado e o CSV nascem na resposta e não são guardados. São valores que o advogado informou, dado do
> cliente dele — trate a cópia do banco com o mesmo cuidado das credenciais. O PDF da prestação de contas **não**
> é guardado em lugar nenhum (nasce na resposta e some), então não há arquivo de custos fora do banco. Nada de
> configuração nova: o recurso não tem variável de ambiente; quem o liga ou desliga por plano é o `/admin`.

### O que o sistema já faz sozinho

Uma cópia por dia, guardando as 7 últimas, em `/dados/backups/`. Ligado por
padrão — `BACKUP_INTERVALO_HORAS=24` e `BACKUP_MANTER=7`.

A cópia é feita com `VACUUM INTO`, e não copiando o arquivo. A diferença
importa: o banco roda em modo WAL, onde uma escrita recente vive no arquivo
`-wal` até o checkpoint. Copiar só o `.db` devolveria um arquivo que abre,
parece íntegro e está desatualizado — o pior tipo de backup, porque ninguém
descobre até precisar dele.

Cada cópia é **conferida antes de ser aceita**: o sistema abre o arquivo
recém-criado, roda `PRAGMA integrity_check` e confere a contagem de contas. Se
não bater, a cópia é apagada e o erro vai para o log. Backup que ninguém abriu
é suposição, não cópia.

Para tirar uma cópia na hora, fora do horário:

```bash
node dist/main/cli.js backup
node dist/main/cli.js backup --manter 14
```

### O limite honesto: isso não é backup ainda

**As cópias ficam no mesmo volume do banco.** Elas protegem contra o que
acontece com mais frequência — apagar a linha errada, um update sem `WHERE`,
um arquivo corrompido, uma migração malfeita. **Não protegem contra perder o
volume**: VPS cancelado, disco que falha, conta suspensa, ransomware.

Backup que mora ao lado do original é meio backup. A outra metade é levar a
cópia para fora do VPS, e isso hoje é trabalho seu. O caminho mais curto, de
qualquer máquina que alcance o VPS por SSH:

```bash
# roda de madrugada, na SUA máquina ou em outro servidor
rsync -az --delete \
  root@SEU-VPS:/var/lib/docker/volumes/processovivo-dados/_data/backups/ \
  ~/backups-processovivo/
```

O caminho exato do volume aparece em `docker volume inspect processovivo-dados`.
Guarde as cópias cifradas se elas saírem para armazenamento de terceiro — o
arquivo contém a credencial de tribunal dos assinantes, cifrada, e o e-mail de
todos eles, em claro.

Uma regra simples para saber se está pronto: **se o VPS sumisse agora, quanto
tempo de trabalho dos seus clientes iria junto?** Se a resposta não for "no
máximo um dia", a cópia externa ainda não está funcionando.

### Restaurar

O procedimento é este, e ele é exercitado por um teste automatizado
(`tests/infrastructure/backup.spec.ts`, "restaurar por cima do banco perdido"):

1. **Pare o serviço** no Easypanel. Restaurar com o serviço no ar sobrescreve
   um arquivo que está sendo escrito, e o resultado é imprevisível.

2. **Escolha a cópia.** Os nomes são `processovivo-<data-hora>.db` e ordenam por
   texto na mesma ordem do tempo, então a última da lista é a mais recente:

   ```bash
   ls -la /dados/backups/
   ```

3. **Confira antes de confiar.** Trinta segundos aqui evitam restaurar lixo por
   cima do que sobrou:

   ```bash
   sqlite3 /dados/backups/processovivo-2026-09-17T03-00-00.db "PRAGMA integrity_check;"
   sqlite3 /dados/backups/processovivo-2026-09-17T03-00-00.db "SELECT COUNT(*) FROM usuarios;"
   ```

4. **Guarde o que ainda existe**, mesmo achando que não presta. O banco
   corrompido de hoje pode ter uma hora de dados que a cópia de ontem não tem:

   ```bash
   mv /dados/processovivo.db /dados/processovivo.db.quebrado
   rm -f /dados/processovivo.db-wal /dados/processovivo.db-shm
   ```

   Apagar o `-wal` e o `-shm` **não é opcional**: eles pertencem ao banco
   antigo, e o SQLite tentaria aplicá-los sobre o novo arquivo.

5. **Copie a cópia por cima**, com o nome que o serviço espera:

   ```bash
   cp /dados/backups/processovivo-2026-09-17T03-00-00.db /dados/processovivo.db
   ```

6. **Suba o serviço.** As migrações e a retrocarga de colunas rodam sozinhas no
   arranque, inclusive se a cópia for de uma versão anterior do Processo Vivo.

7. **Confira pela porta da frente**, não pelo log: entre com uma conta, veja se
   a carteira está lá, e confira que uma peça ainda baixa — é isso que prova que
   a chave do cofre continua casando com o banco restaurado.

### A chave do cofre: o único segredo que o backup não salva

`PROCESSOVIVO_CREDENCIAL_CHAVE` é o que cifra a senha de cada advogado no tribunal.
Ela **não está no banco** — mora na configuração do serviço. É por isso que um
vazamento do banco não entrega credencial nenhuma.

A consequência é a que ninguém lembra na hora errada: **restaurar o banco com
uma chave diferente não recupera as credenciais.** Elas continuam lá, cifradas,
ilegíveis para sempre, e cada assinante precisa cadastrar a senha do tribunal
de novo — um por um, cada um com o próprio constrangimento de ser avisado.

Então:

- **Guarde a chave no gerenciador de senhas**, junto da anotação de qual
  instalação ela abre. Não no VPS, não num arquivo ao lado do backup, não numa
  conversa.
- **Nunca troque a chave** depois que houver credencial cadastrada. Não há
  migração automática de uma chave para outra.
- **Confira a custódia antes de vender o primeiro acesso.** A pergunta é: se o
  VPS sumir hoje, você consegue subir outro com a MESMA `PROCESSOVIVO_CREDENCIAL_CHAVE`?
  Se a resposta for não, a restauração vai devolver o banco e não o sistema.

O mesmo vale, em menor grau, para `PROCESSOVIVO_API_KEYS`: perdê-las derruba as
integrações até você distribuir chaves novas — recuperável, mas ninguém quer
descobrir isso no mesmo dia em que perdeu o disco.

### Senha esquecida: configure o SMTP antes do primeiro cliente

A recuperação de senha só existe com `SMTP_HOST` **e** `PROCESSOVIVO_URL_BASE`
preenchidos. Sem os dois, a tela de entrada nem mostra o "esqueci minha senha" —
de propósito: aceitar o pedido, responder "enviamos um e-mail" e não enviar nada
faria a pessoa esperar uma mensagem que não vem.

Para conferir depois do deploy, sem criar conta nenhuma:

```bash
curl -s https://app.processovivo.com.br/v1/senha/recuperar
# {"disponivel":true}
```

`false` aqui significa que o único caminho para quem perder a senha é você
mexendo no banco. Resolva antes de haver cliente.

---

## Google Drive: salvar as peças na pasta do advogado (v0.42.0)

O botão **Salvar no Drive**, na Pasta digital, grava as peças do processo no Google Drive do
advogado: uma pasta **Processo Vivo** e, dentro dela, uma subpasta por processo (o nome é o
número). Nasce **desligado**; você liga quando o Google estiver configurado.

**O que o sistema pede ao Google, e só isso:** o escopo `drive.file` — acesso apenas aos
arquivos e pastas que o próprio Processo Vivo criou. Ele **não lista, não lê, não apaga, não
renomeia e não compartilha** nada do Drive do advogado. Peça sob sigilo e processo em segredo
de justiça **não vão** para o Drive. Nada é enviado sem o clique.

### 1. No Google Cloud (uma vez)

1. Em <https://console.cloud.google.com>, crie um projeto (ou use um que já tenha) e ative a
   **Google Drive API** (APIs e serviços → Biblioteca).
2. **Tela de consentimento OAuth** (Google Auth Platform): tipo **Externo**; nome do app e
   e-mail de suporte; domínio autorizado `processovivo.com.br`; endereços da política de
   privacidade e dos termos. Em **Escopos**, adicione **somente**
   `https://www.googleapis.com/auth/drive.file`.
3. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web.** Em
   **URIs de redirecionamento autorizados**, cole **exatamente**:
   `https://app.processovivo.com.br/v1/drive/retorno` (o valor de `PROCESSOVIVO_URL_BASE` +
   `/v1/drive/retorno`, sem barra no fim e sem espaço). Copie o **ID do cliente** e o
   **Segredo do cliente**.
4. **Enquanto o app está em "Teste"**: só entram as contas Google cadastradas em **Usuários de
   teste** (até 100), e a autorização **vence em 7 dias** — o advogado precisará reconectar a
   cada semana. Serve para validar. Para o uso real, **publique o app** (Público-alvo →
   Publicar). O escopo `drive.file` **não é restrito** nem sensível, então em geral não exige a
   verificação pesada do Google (só a marca: nome, logo e a política de privacidade no ar).

### 2. No Easypanel (aba Environment)

```text
PROCESSOVIVO_DRIVE_HABILITADO=true
GOOGLE_CLIENT_ID=<o ID do cliente que o Google mostrou>
GOOGLE_CLIENT_SECRET=<o segredo do cliente que o Google mostrou>
PROCESSOVIVO_URL_BASE=https://app.processovivo.com.br
PROCESSOVIVO_CREDENCIAL_CHAVE=<a chave do cofre, que já existe>
```

Os dois últimos já existem na instalação; não troque a chave do cofre. Se faltar qualquer uma, ou
se o ID/segredo parecer texto de exemplo, **o serviço recusa subir** e diz qual variável falta
(nunca mostra o valor). Para **desligar**, volte `PROCESSOVIVO_DRIVE_HABILITADO=false` e faça o
deploy: o cartão e o botão somem e as rotas respondem 501; nada é apagado.

### 3. Dar o recurso a uma conta (/admin)

O recurso se chama **Salvar no Google Drive** e já vem nos planos **Peças** e **IA** (a
retrocarga o acrescenta uma vez aos planos já gravados). Para dar a uma conta:
`/admin` → **Assinaturas** → procure o e-mail → **Liberar plano** → escolha **Peças** (ou IA).
Para dar a um plano que você criou: `/admin` → **Planos** → editar → marque **Salvar no Google
Drive** (e deixe **Peças do processo** marcado: o Drive envia o que a Pasta digital guarda).
O plano Acompanhamento não tem o recurso. Conta **sem assinatura** (chave de API) também não: a
regra de plano é a mesma para quem entra por cookie e por chave. Conta de chave só usa o Drive se o
workspace dela (o identificador de 16 caracteres da chave) tiver uma assinatura de plano Peças ou IA.
Uma chave não tem e-mail, então a liberação é **pelo workspace** (v0.42.1):

**Onde está o id do workspace:** `/admin` → **Chaves de API** → coluna **Workspace** (16
caracteres hexadecimais; selecione e copie). Na aba **Assinaturas**, a linha de uma chave que já tem
plano mostra o mesmo id ao lado de "(sem conta — chave de API)". Chave do arquivo de configuração
(`PROCESSOVIVO_API_KEYS`) não aparece na lista: o id dela é o `workspace` que `node dist/main/cli.js
assinatura ver` (sem argumento) mostra quando ela já tem assinatura, ou o da chave emitida no
`/admin`, que é o caminho recomendado.

**Liberar, em produção** (no terminal do contêiner; troque o id, o plano e os meses; o id abaixo é
sintético):

```bash
node dist/main/cli.js assinatura liberar --workspace 0123456789abcdef pecas 60 --obs "chave do operador"
node dist/main/cli.js assinatura ver --workspace 0123456789abcdef
```

Ou, no `/admin` → **Assinaturas** → campo **Workspace** (deixe o e-mail vazio) → **Liberar /
renovar**. Nunca os dois campos juntos. O id precisa ser de uma conta, de uma chave emitida e não
revogada ou de uma chave do `.env`; senão nada é gravado.

**Cuidado com o vencimento:** assinatura de chave **vence como qualquer outra**. Passada a
carência, o workspace é barrado em tudo (402), inclusive consulta e acompanhamento, e **não sai
e-mail de aviso** (não há conta). Use `60` meses e anote a data que o comando imprime.
(Desde a v0.50.0 o plano IA pode ir à venda — ver "Plano IA à venda" abaixo; o Drive não muda isso.)

O retorno do Google (`/v1/drive/retorno`) é uma navegação do navegador, sem `x-api-key` nem cookie:
o dono da conexão sai do `state` assinado, emitido por `POST /v1/drive/conexao` (esse sim
autenticado). Por isso a conexão também se completa para conta de chave de API.

---

## Cobrança recorrente pelo Mercado Pago (v0.44.0)

A conta passa a poder **assinar** um plano pela própria tela "Minha conta": o Mercado Pago cobra o
**cartão** a cada ciclo e o Processo Vivo libera e renova o plano sozinho. Nasce **desligada**. A
liberação manual (Pix por fora, `assinatura liberar`) continua igual.

**O que o sistema nunca faz:** receber ou guardar número de cartão. O comprador paga na página do
Mercado Pago. Do pagador, o sistema só guarda id, estado, valor, datas e o tipo do meio.

**Só cartão, e só mensal (por enquanto).** A recorrência é por cartão; Pix e boleto avulsos ficam para
a próxima versão. Só o ciclo **mensal** pode ser contratado pelo site; o campo de ciclo no plano
(mensal, trimestral, anual) já existe para os outros entrarem depois sem mudar código.

### 1. No Mercado Pago (uma vez)

1. Em **Suas integrações**, crie a **aplicação** (tipo pagamentos online) e anote as credenciais. Faça
   primeiro com as de **teste** (e usuários de teste: um vendedor e um comprador).
2. **Webhooks → Configurar notificações.** Cadastre o endereço (modo teste e modo produção têm campos
   separados; use o de cada ambiente):

   ```text
   https://app.processovivo.com.br/v1/pagamentos/webhook/mercadopago
   ```

   Eventos a marcar: **Planos e assinaturas** (`subscription_preapproval` e
   `subscription_authorized_payment`) e **Pagamentos** (`payment`).
3. Ao salvar, o painel mostra a **assinatura secreta** do webhook: é ela o `MERCADOPAGO_WEBHOOK_SECRET`.
4. O sistema também manda o endereço do aviso **na criação de cada assinatura** (`notification_url`).
   A configuração do painel é a segunda via: se o Mercado Pago não aceitar um dos dois para
   assinaturas, o outro cobre. (Confirmar no teste; ver o CHANGELOG da 0.44.0.)

### 2. No Easypanel (aba Environment)

```text
PROCESSOVIVO_PAGAMENTO_HABILITADO=true
PROCESSOVIVO_PAGAMENTO_AMBIENTE=<teste ou producao; obrigatória, sem padrão>
MERCADOPAGO_ACCESS_TOKEN=<o token da aplicação; o prefixo NÃO diz se é teste (também vem como APP_USR-)>
MERCADOPAGO_WEBHOOK_SECRET=<a assinatura secreta que o painel mostrou>
PROCESSOVIVO_URL_BASE=https://app.processovivo.com.br
PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL=<seu e-mail, para estorno e contestação>
PROCESSOVIVO_TERMOS_URL=<o endereço dos Termos de Uso, se já houver>
PROCESSOVIVO_TERMOS_VERSAO=<a versão dos Termos que o cliente aceita antes de pagar; em produção: 1.1>
```

**Desde a 0.45.0 `PROCESSOVIVO_TERMOS_VERSAO` é obrigatória** com a cobrança ligada (o serviço recusa subir sem
ela e diz qual variável falta). Todo checkout exige o aceite dos Termos: a tela de confirmação tem uma caixa
desmarcada, e o servidor grava (tabela `aceites_termos`) a versão, o plano e a data, ligados ao workspace —
sem e-mail e sem IP. Quando publicar os novos Termos, troque a variável para `1.2` e faça o redeploy.

Se faltar a credencial, ou se ela parecer texto de exemplo, **o serviço recusa subir** e diz qual
variável falta (nunca mostra o valor). O ambiente é o que **você declara** em `PROCESSOVIVO_PAGAMENTO_AMBIENTE` (`teste` ou `producao`), nunca o
prefixo do token: o Mercado Pago passou a emitir credencial de teste com `APP_USR-`. A variável é
obrigatória e não tem padrão. Token `TEST-` com `producao` também é recusado. **Ambiente `teste` em servidor
de produção é recusado**, a não ser que você ponha `PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE=true` (para testar
de propósito no servidor de verdade). Em `teste`, o `/admin` mostra **TESTE** em destaque na aba Assinaturas
e na aba Planos, e a tela da conta diz "MODO DE TESTE".

Para **desligar**, volte `PROCESSOVIVO_PAGAMENTO_HABILITADO=false` e faça o deploy: o botão some, as
rotas de checkout deixam de existir e o webhook responde 404. Nada é apagado; quem já assinou continua
com o plano até o fim do período pago, mas o Mercado Pago continua cobrando até a assinatura ser
cancelada **lá** — cancele no painel dele antes de desligar de vez.

### 3. Preço e ciclo (/admin → Planos)

O sistema cobra o valor cadastrado no plano: **preço por mês** × meses do ciclo. **Plano sem preço não
pode ser contratado** (nem aparece o botão "Assinar"), e plano pausado também não. No formulário do
plano há o campo **Ciclo de renovação**; hoje só `mensal` é vendável.

### 4. O dia a dia

- **Tudo certo:** o pagamento aprovado renova o plano pelo MESMO caminho do `assinatura liberar`.
- **Cartão recusado:** o plano segue até vencer, a conta recebe um e-mail e o Mercado Pago tenta de
  novo. Depois de 3 parcelas recusadas ele cancela a assinatura sozinho, e a conta é avisada de que
  nada mais renova.
- **Cancelar a renovação:** a própria conta faz em "Minha conta"; o plano vale até o fim do período
  pago e o evento fica na trilha de auditoria (tabela `eventos_de_pagamento`).
- **Estorno ou contestação:** o sistema **não revoga** o acesso. Chega um e-mail para
  `PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL`; decida no `/admin` (Assinaturas → cancelar, se for o caso).
- **Aviso perdido (a conta pagou e o plano não renovou):** `/admin` → Assinaturas → **Reconciliar
  cobranças** (ou o botão da linha), ou, no terminal do contêiner:

  ```bash
  node dist/main/cli.js pagamento reconciliar
  node dist/main/cli.js pagamento reconciliar --workspace 0123456789abcdef
  ```

  Consulta o Mercado Pago, corrige o que divergir e imprime só contagens. É seguro repetir: um
  pagamento nunca renova duas vezes.
- **O Mercado Pago recusou o pedido (v0.45.1):** a tela diz o motivo em português e o `/admin` mostra, no alto
  da aba Assinaturas, a **última falha do gateway** (data, operação, status, código e motivo). O detalhe fica no
  log do contêiner, na linha **"gateway de pagamento recusou o pedido"** (nível `warn`): traz o status, o `error`, a
  `message`, o `code` e a `description` de cada causa e os nomes dos campos enviados — sem token, sem e-mail em claro
  e sem valores. Motivos: `email_pagador`, `credencial`, `parametro_invalido`, `indisponivel`, `desconhecido`.
  Com credencial de **teste**, o e-mail do pagador precisa ser de um usuário de teste do Mercado Pago (do mesmo
  país e diferente do e-mail do vendedor).
- **Conta de chave de API** (sem e-mail) não assina online: a liberação dela continua manual, pelo
  workspace (ver a seção do Drive).

---

## Plano IA à venda (v0.50.0)

O plano IA (Peças + análise com IA) é vendido pelo mesmo caminho dos outros: site, app e checkout do Mercado Pago.
**Nada liga sozinho**: a semente deixa o IA **fora de venda e sem preço**. Quem decide é o operador, no `/admin`.

1. **Pré-requisitos no Easypanel:** `PROCESSOVIVO_IA_HABILITADA=true` e `OPENROUTER_API_KEY` (a análise em si) e a
   cobrança ligada (seção do Mercado Pago acima). `PROCESSOVIVO_IA_HABILITADA=false` continua sendo a chave geral: desliga
   o botão para todo mundo, inclusive para quem pagou.
2. **Apague `PROCESSOVIVO_IA_WORKSPACES_LIBERADOS`** se ainda estiver lá. Ela não libera mais nada (só gera um aviso no
   log). A conta que usava a IA por ela precisa do plano IA liberado no `/admin` → Assinaturas, **antes** do deploy.
3. **`/admin` → Planos → IA → Editar:** preço `99,90` (ou o que decidir) e marque **à venda**. Sem preço o `/admin`
   recusa ("Defina o preço antes de colocá-lo à venda"). O teste grátis não pode ser o plano IA (a regra recusa).
4. **Teto técnico** (opcional): `PROCESSOVIVO_IA_MAX_POR_DIA` (padrão `200`) — análises por conta por dia (dia de São
   Paulo), em memória. Não é limite do plano; é o freio contra uso anômalo. Atingido, a tela diz "Muitas análises hoje.
   Tente de novo amanhã ou fale com a gente." e o modelo não é chamado. Os freios de antes (`PROCESSOVIVO_IA_MAX_POR_HORA`,
   `PROCESSOVIVO_IA_MAX_SIMULTANEAS`) continuam. O teto de gasto de verdade continua sendo o limite da chave no OpenRouter.
5. **Custo médio por análise:** cada análise concluída é uma linha em `analises_ia` (modelo, provedor, duração, tokens e
   custo em US$ quando o OpenRouter informa; nenhum texto de ato). No Console do serviço:

   ```bash
   node scripts/ia-avaliacoes.mjs
   ```

   A coluna de custo médio é por modelo e versão do prompt. Análise que falhou antes de chegar ao modelo (sem plano,
   sigilo, teto) não gera linha; análise que o modelo não concluiu (erro) também não.

## Análise de peça por IA, "Analisar peça com IA" (v0.55.0)

O botão aparece ao lado de cada peça na linha do tempo. **Nasce desligado.** Duas chaves decidem quem vê:

| Variável | Padrão | O que faz |
|---|---|---|
| `PROCESSOVIVO_IA_PECAS_HABILITADA` | `false` | `true` libera **todas** as contas que têm o plano com análise por IA. |
| `PROCESSOVIVO_IA_PECAS_WORKSPACES` | vazio | Lista de contas liberadas (identificadores de 16 ou 32 caracteres, separados por vírgula). Vale quando a chave de cima está `false`. |

Em qualquer caso a conta **também precisa do plano IA** (liberado no `/admin` ou assinado). Sem as duas chaves o botão não aparece. Tudo isto exige o que a análise de ato já exige: `PROCESSOVIVO_IA_HABILITADA=true` e `OPENROUTER_API_KEY`.

**Só para contas escolhidas (o estado de partida):**

1. Descubra o identificador de cada conta. No Console do serviço (Easypanel): `node dist/main/cli.js assinatura ver email@da.conta` — a linha `workspace .....` é o identificador. (Conta de chave de API: o id aparece em `/admin` → Chaves de API.)
2. Confira que a conta tem o plano IA: a mesma saída mostra o plano. Se não tem: `node dist/main/cli.js assinatura liberar email@da.conta ia 1`.
3. No Easypanel, aba **Environment**: `PROCESSOVIVO_IA_PECAS_WORKSPACES=<id-do-dono>,<id-do-avaliador>` e `PROCESSOVIVO_IA_PECAS_HABILITADA=false`. Salve e reinicie. Id torto não derruba o serviço: o log avisa quantos foram ignorados (sem repetir o valor).
4. A conta da lista vê o botão em cada peça (linha do tempo e visualizador da Pasta digital) e avalia o resultado pelo **polegar** (para cima = útil; para baixo = com problema, com motivo opcional). Quem não está na lista não vê nada.

**Para todos, depois da Política de Privacidade e dos Termos v1.4 publicados:** troque para `PROCESSOVIVO_IA_PECAS_HABILITADA=true` e reinicie. A lista deixa de importar; todas as contas com o plano IA passam a ver o botão. A avaliação é o mesmo polegar para todas (desde a 0.56.0 não há mais modo de avaliação na tela).

**Limites e custo:** só TJGO; só peça com texto pesquisável (PDF escaneado é recusado, sem OCR); até 40 páginas e 80 mil caracteres. Cada análise pesa **5** no teto diário `PROCESSOVIVO_IA_MAX_POR_DIA` (padrão 200 → 40 peças por conta por dia) e conta uma no freio `PROCESSOVIVO_IA_PECAS_MAX_POR_HORA` (6). Modelo: `PROCESSOVIVO_IA_PECAS_MODELO` (vazio = o de `PROCESSOVIVO_IA_MODELO`). O resultado fica guardado 30 dias (`PROCESSOVIVO_IA_PECAS_RESULTADO_DIAS`); o texto da peça nunca é gravado.

**Conferir uso e custo (somente leitura, só contagens):**

```bash
node scripts/ia-pecas-uso.mjs        # por conta: análises vigentes, hoje, peso no teto, avaliadas, custo
node scripts/ia-avaliacoes.mjs       # seção "Análises de peça": avaliações, motivos, custo p50/p95/máximo
```

---

## IA de peças, Fase 0: medir a camada de texto e comparar modelos em peças (v0.53.0)

Nada muda para o usuário: são ferramentas **manuais**, no Console do serviço, sem rota e sem chamada de IA nova em produção. O `poppler-utils`
(`pdftotext`) **já está na imagem** desde a 0.30.0; o `Dockerfile` só passou a copiar os conjuntos sintéticos do comparador.

1. **Medir a camada de texto das peças guardadas** (só leitura, sem rede, só números):

   ```bash
   node scripts/pecas-medir-texto.mjs
   ```

   Mostra: peças na guarda, % com texto pesquisável, % escaneadas (sem OCR), páginas e caracteres (p50, p95, máximo), % acima de 40 páginas e de 80 mil
   caracteres, falhas por tipo, tempo de extração e a origem do arquivo guardado. **Nunca** mostra texto, nome, número de processo ou workspace. A amostra é o
   que está na guarda agora (24 h): repita em dias diferentes. Variáveis lidas: `PROCESSOVIVO_DB_PATH` e `LEITOR_PASTA` (as do serviço).

2. **Comparar modelos na leitura de peças** (só peças inventadas; mesmas regras do comparador da 0.52.0 — ZDR da lista oficial de agora, teto de gasto
   padrão US$ 1,00, `OPENROUTER_API_KEY` só na variável de ambiente):

   ```bash
   node scripts/ia-comparar-modelos.mjs --tarefa=pecas --modelos=fabricante/modelo-a            # só estima
   node scripts/ia-comparar-modelos.mjs --tarefa=pecas --modelos=fabricante/modelo-a --executar  # roda de verdade
   node scripts/ia-comparar-modelos.mjs --julgar-revisao=<planilha preenchida>.csv                # errado e perigoso
   ```

   Saída em `dados/comparador-ia/`: `comparacao-pecas-<data>-<hora>.md` (com o critério da seção 8), `-metricas.csv` e `-revisao-humana.csv` (preencher a coluna
   `avaliacao` com `util`, `errado` ou `perigoso`). Preços são estimativa, não confirmados. **Nenhum modelo entra em produção por este relatório.**

3. **Risco residual a lembrar:** a redação de peça cobre CEP, RG/CNH com rótulo, data de nascimento e conta/agência com rótulo, além do que o ato já cobria; **não
   cobre endereço nem nome de terceiro** fora do retrato. O processo filho do `pdftotext` tem tempo e saída máximos, mas não limite de CPU/memória.

## Resumo do processo: diagnóstico e comparação 1.1.0 × 1.2.0 (v0.54.0; atualizado na v0.56.0)

Ferramentas **manuais** no Console do serviço (sem rota; nada muda para o usuário além do resumo em si).

1. **Diagnóstico de um processo** (só leitura, sem rede, só números; o número do processo é argumento e nunca é impresso):

   ```bash
   node scripts/diagnostico-resumo.mjs <número do processo>
   node scripts/diagnostico-resumo.mjs <número do processo> --workspace=<id ou e-mail>   # se mais de uma conta acompanha
   ```

   Mostra, para os 5 atos mais recentes, o tamanho de cada campo de texto, se o resumo o considera utilizável (e por que não), se é providência do sistema e como a
   seleção o tratou; e, desde a 0.54.0, se o ato mais recente foi lido, quantas junções de "mesmo ato" houve e os atos não lidos por motivo.

2. **Comparar `resumo-1.1.0` (a de antes) × `resumo-1.2.0` (a conciso, em produção desde a 0.56.0)** com processos inventados (8 em `tests/fixtures/ia-resumo/casos.json`). Precisa de `OPENROUTER_API_KEY` e de
   `PROCESSOVIVO_IA_MODELO` (o modelo de produção, sempre a referência). Requer `npm run build` fora da imagem.

   ```bash
   node scripts/ia-comparar-modelos.mjs --tarefa=resumo             # só ESTIMA: nada é enviado
   node scripts/ia-comparar-modelos.mjs --tarefa=resumo --executar  # roda as duas versões (teto padrão US$ 1,00)
   node scripts/ia-comparar-modelos.mjs --tarefa=resumo --executar --versoes=resumo-1.2.0 --teto-usd=2   # só a nova, com outro teto
   ```

   Saída em `dados/comparador-ia/`: `comparacao-resumo-<data>-<hora>.md`, `-metricas.csv` e `-revisao-humana.csv`. A avaliação automática é um filtro, não um
   juiz. Os números que importam: "atual indevida" e "negou pendência" devem ser **0**; "abre no ato mais recente" deve cobrir todos os casos em que ele foi lido; e a 1.2.0 deve ter a
   situação média perto de 320 caracteres e a pendência média perto de 160 (as colunas "Situação" e "Pendência"). Preços são estimativa, não confirmados.

## Medir e comparar a análise por IA (v0.52.0)

Nada aqui muda a produção: o modelo, o prompt e as regras de verificação continuam os de sempre. São três ferramentas
**manuais** (nunca rodam sozinhas, nem no CI, nem no servidor), todas fora do repositório.

1. **Relatório da produção** (só lê o banco; nenhum texto de ato, nome ou número de processo):

   ```bash
   node scripts/ia-avaliacoes.mjs
   ```

   Por modelo e versão do prompt: análises, avaliações (polegar para cima = Útil; para baixo = Errado, ou Perigoso quando o motivo é
   "pode causar prejuízo"), não verificadas, latência p50/p95, custo médio, p50, p95 e máximo (só onde o OpenRouter informou) e, entre
   os polegares para baixo, a contagem por **motivo** (erro de fato, citação inventada, concluiu prazo, deixou de fora algo importante,
   pode causar prejuízo, outro, sem motivo). O resumo de processo e a análise de peça aparecem em seções separadas.

2. **Comparar modelos com casos inventados** (48 casos sintéticos em `tests/fixtures/ia-avaliacao/casos.json`).
   Precisa de `OPENROUTER_API_KEY` (só na variável de ambiente; nunca é impressa nem gravada) e de
   `PROCESSOVIVO_IA_MODELO` (o modelo de produção, que entra sempre como referência). Requer `npm run build`.

   ```bash
   # 1) só ESTIMA: nada é enviado ao modelo
   node scripts/ia-comparar-modelos.mjs --modelos=fabricante/modelo-a,fabricante/modelo-b
   # 2) roda de verdade (teto de gasto padrão: US$ 1,00 por rodada)
   node scripts/ia-comparar-modelos.mjs --modelos=fabricante/modelo-a,fabricante/modelo-b --executar
   # 3) com outro teto, ou só algumas categorias de caso
   node scripts/ia-comparar-modelos.mjs --modelos=fabricante/modelo-a --executar --teto-usd=2 --categorias=prazo_escrito,armadilha
   ```

   - Só roda modelo que a **lista oficial de ZDR** do OpenRouter aprova na hora; o resto é recusado. Lista
     inalcançável ou modelo de produção fora dela: nada é enviado.
   - Se a estimativa já passa do teto, o comando recusa executar. Durante a rodada, o gasto é somado e a rodada
     **para** quando o teto é atingido (o relatório diz que ficou incompleta).
   - **Os preços são estimativas** (preço de lista do OpenRouter × tokens) quando a resposta não traz o custo; o
     relatório diz a origem de cada custo. Confirme com o provedor antes de decidir qualquer coisa.
   - Saída em `dados/comparador-ia/` (ou `--saida=`; dentro do repositório é recusada): `comparacao-<data>-<hora>.md`
     (relatório), `-metricas.csv` e `-revisao-humana.csv` (uma linha por caso e modelo, com a coluna `avaliacao`
     vazia para uma pessoa preencher). A avaliação automática é um filtro; quem decide é a revisão humana.
   - **Nenhum modelo entra em produção por este relatório.** A troca é decisão do dono (variável
     `PROCESSOVIVO_IA_MODELO` no Easypanel).

3. **Avaliação na tela** (produção, desde a 0.56.0): no fim do resultado do resumo, da análise do ato e da análise de peça, dois
   ícones de polegar. Para baixo aparece o motivo (opcional, uma escolha fixa; nunca texto livre). A coluna `motivo_avaliacao` é
   aditiva; o motivo "pode causar prejuízo" é gravado como `perigoso`; nada é apagado.

O resumo de processo agora conta no mesmo **teto técnico diário por conta** da análise de ato
(`PROCESSOVIVO_IA_MAX_POR_DIA`, padrão 200): uma análise ou um resumo, cada um conta 1. O freio de 6 por hora do resumo
(`PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA`) e a mensagem neutra continuam.

## Calendário: lembretes no feed e resumo por e-mail (v0.51.0)

Duas coisas novas, com controles diferentes.

**1. Lembretes no feed (`VALARM`).** Não há variável: a pessoa escolhe em Calendário > Assinar no meu
calendário (1 dia antes e/ou 1 hora antes). **Padrão: nenhum**, então o feed continua igual ao de antes até
alguém escolher. Só eventos **confirmados** e ainda no futuro levam lembrete. Apple Calendário e Outlook
costumam mostrá-los; o Google Agenda pode ignorá-los em calendários assinados por URL (a tela diz isso).

**2. Resumo por e-mail dos eventos a confirmar.**

```text
PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO=false
```

- **Padrão: desligado.** É a chave GLOBAL: desligada, nenhum e-mail sai e a tela não mostra a opção.
- Ligada, manda **um e-mail por conta, no máximo um por dia, entre 08:00 e 12:00 (São Paulo)**, só se houver
  evento detectado novo para confirmar (ou que o andamento mais recente sugere rever). Cada conta pode
  desligar em **Calendário > Resumo por e-mail** (o padrão da conta é ligado). O primeiro envio leva TUDO o
  que já está esperando confirmação (até 10 itens listados e "e mais N").
- **Só envia com SMTP de verdade** (`SMTP_HOST` e `SMTP_FROM`). Sem eles, o serviço não é montado e o log
  avisa; o modo log não conta como entrega.
- Conta de chave de API (sem e-mail) não recebe. O e-mail vai para o e-mail de LOGIN da conta.
- Falha de envio não derruba nada: o item é tentado no máximo 3 vezes (a cada 15 min) e depois para.
- Três tabelas novas e aditivas (preferência, itens avisados, envios); sem e-mail, sem texto, sem número.

Para ligar com segurança: (1) faça o deploy com a chave **desligada**; (2) confira o painel e o feed (importe o
feed no Apple Calendário ou no Outlook e veja o lembrete); (3) rode a prévia, que **não envia nada** e só
mostra contagens:

```bash
npm run cli -- calendario resumo-previa
# em produção (contêiner): node dist/main/cli.js calendario resumo-previa
```

(4) ligue `PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO=true` e faça o deploy; (5) confira o primeiro envio entre
08:00 e 12:00. Para **desligar**, volte para `false` e faça o deploy: nada é apagado.

## Endpoints

| Método | Rota | Auth | O que faz |
|---|---|---|---|
| GET | `/health` | não | processo vivo (Docker/Easypanel usam esta) |
| GET | `/ready` | não | consegue atender? lista o estado das fontes |
| GET | `/v1/processos/:numero` | sim | processo por número CNJ, com ou sem máscara |
| GET | `/v1/advogados/:uf/:oab/processos` | sim | carteira do advogado |
| POST | `/v1/contas` | não | cria a conta e já entra (cadastro aberto) |
| POST | `/v1/sessoes` | não | entrar; `DELETE` sai |
| GET | `/v1/planos` | não | vitrine do site de vendas: planos à venda e `pagamentoDisponivel`; CORS só para `PROCESSOVIVO_SITE_URL` |
| GET | `/v1/senha/recuperar` | não | esta instalação manda e-mail? `{"disponivel":…}` |
| POST | `/v1/senha/recuperar` | não | pede o link; responde **sempre** 202 |
| POST | `/v1/senha/redefinir` | não | troca a senha pelo link e já entra |
| GET | `/v1/drive` | sim | Google Drive: `{habilitado:false}` se desligado; senão o estado da conexão |
| POST | `/v1/drive/conexao` | sim | devolve o endereço de autorização do Google |
| GET | `/v1/drive/retorno` | não — o `state` assinado manda | volta do Google (navegação, sem cookie nem chave); **sempre** redireciona para a tela, sem token |
| DELETE | `/v1/drive` | sim | desconecta (revoga e apaga a autorização) |
| POST | `/v1/processos/:numero/pasta/drive` | sim | salva peças no Drive (só chaves de peças da pasta); 202 + id |
| GET/DELETE | `/v1/drive/jobs/:id` | sim | progresso / cancelar o envio |

Query opcional na carteira: `?ordenarPor=DISTRIBUICAO` (padrão:
`ULTIMA_MOVIMENTACAO`).

Toda resposta de processo traz `x-processovivo-fonte` (qual fonte respondeu) e
`x-processovivo-cache` (`true` se veio da memória). Não trate dado de cache como
consulta ao vivo quando houver prazo em jogo.

### Códigos de status

| Código | Significado | É problema seu? |
|---|---|---|
| 400 | número CNJ ou OAB inválidos | não, o cliente errou |
| 401 | chave ausente ou inválida, sessão vencida, link de recuperação morto | não |
| 404 | consultamos, o processo não existe | não |
| 429 | limite de requisições estourado | não |
| 501 | nenhuma fonte sabe fazer essa busca | é escopo, não falha |
| 502 | as fontes externas falharam | **rio acima** — tribunal ou CNJ |
| 503 | fonte temporariamente indisponível | rio acima, tente de novo |
| 500 | bug do Processo Vivo | **sim** — só este merece alarme |

Essa separação é deliberada: se tribunal fora do ar virasse 500, o alarme
tocaria o tempo todo por algo que não é seu, e o 500 de verdade se perderia no
meio.

---

## Testando local antes de subir

```bash
docker compose up --build
curl -H "x-api-key: chave-local-de-desenvolvimento" \
  http://localhost:3000/v1/processos/1234567-47.2023.8.26.0100
```

É a mesma imagem que o Easypanel constrói. Se passar aqui, passa lá.

---

## Quando der errado

**502 Bad Gateway no domínio, mas o contêiner está "running"**
A porta alvo do domínio não bate com a do contêiner. Confira: `Port = 3000` na
aba Domains e `HTTP_PORT=3000` no Environment.

**O contêiner reinicia em loop**
Veja o log. Se aparecer `Configuração recusada: defina PROCESSOVIVO_API_KEYS…`, é a
guarda do passo 1 — a variável não foi salva. Se aparecer
`Configuração inválida:` seguido do nome de uma variável, o valor está fora do
formato (número onde se esperava número, URL onde se esperava URL).

**Sobe, o log diz "Processo Vivo no ar", mas nada responde**
`HTTP_HOST` está como `127.0.0.1`. Dentro do contêiner isso significa "só eu
mesmo": o proxy não alcança. Tem que ser `0.0.0.0`.

**Uma fonte aparece no `/ready` com `saudavel: false`**
A partir da v0.4.0 vem o campo `motivo` junto, dizendo o que é. Se o motivo
mencionar **texto de exemplo**, a variável ficou com o placeholder da
documentação em vez do valor real — apague o conteúdo dela (ou cole a chave de
verdade) e redeploye. Uma fonte com credencial de exemplo aparece na lista como
se estivesse com problema de disponibilidade, quando na verdade nunca foi
configurada.

**`/ready` devolve 503**
Nenhuma fonte respondeu. Com `PROCESSOVIVO_PROVIDER_CHAIN=datajud,djen` o DJEN
responde em menos de 1s e sem chave, então 503 aqui normalmente é a cadeia mal
escrita — confira se não há espaço ou nome errado na variável — ou o VPS sem
saída para `comunicaapi.pje.jus.br`.

**`PROVIDER_INDISPONIVEL: HTTP 403` no DJEN ou no DataJud**
403 vindo de host que não é o CNJ é rede, não credencial. O contêiner precisa de
saída HTTPS para `comunicaapi.pje.jus.br` (DJEN) e `api-publica.datajud.cnj.jus.br`
(DataJud). Em VPS com allowlist de egresso, libere os dois.

**Primeiro acesso depois de atualizar para a v0.11**
A tela agora pede e-mail e senha. Como ainda não existe conta nenhuma, ela abre
direto em **Criar conta** — e o "código de acesso" é a chave que está em
`PROCESSOVIVO_API_KEYS`. A PRIMEIRA conta criada adota o workspace da primeira chave,
então a carteira que você já tinha continua lá. Se criar a conta e a carteira
aparecer vazia, confira se `PROCESSOVIVO_API_KEYS` continua com a MESMA chave de
antes: mudou a chave, mudou o workspace.

**"Faço login e volto para a tela de login"**
É o cookie sendo descartado pelo navegador. Confira `HTTP_TRUST_PROXY=true` —
é ele que decide se o cookie sai com `Secure`, e `Secure` sob HTTP puro é
descartado em silêncio.

**A aba Vigilância responde 501**
Falta `djen` em `PROCESSOVIVO_PROVIDER_CHAIN`. É a única fonte que indexa advogado.
Repare que valor preenchido no painel GANHA do padrão do código — se a variável
ficou com o valor antigo de uma versão anterior, o DJEN não entra.

**Cadastrei a OAB e não apareceu processo nenhum**
A primeira varredura cobre 30 dias. Processo sem publicação no diário nesse
período não aparece — é o limite da fonte, não defeito. Confira também se
`varridaEm` saiu de "ainda não verificada" na própria aba.

**Não chega e-mail**
Sem `SMTP_HOST` o sistema fica em modo log de propósito: procure no log a linha
"notificação (SMTP não configurado — nada foi enviado)". Com SMTP configurado e
ainda sem chegar, a linha "falha ao enviar e-mail" traz o motivo do servidor.

**A busca por OAB não devolve nada**
Confira se `djen` está em `PROCESSOVIVO_PROVIDER_CHAIN`: é a única fonte do projeto
que faz essa busca. Se estiver e ainda vier vazio, é o limite da fonte, não um
defeito — o DJEN só conhece processos que tiveram publicação no diário, e o
histórico dele começa por volta de 2023.

**401 mesmo com a chave certa**
Espaços em volta das vírgulas são tolerados, então não é isso. As causas reais:
a chave foi truncada no copiar-e-colar (confira o tamanho — deve ter 64
caracteres), ou você está mandando em `Authorization` sem o prefixo `Bearer `.
Ambos os formatos valem: `x-api-key: <chave>` ou `Authorization: Bearer <chave>`.
Para saber qual chave o servidor aceitou, compare o campo `chave` do log com o
identificador que o `npm run chave` imprimiu.

**Contêiner recusa subir com "Configuração de autenticação recusada"**
A mensagem diz exatamente o quê: chave ausente, chave com menos de 24
caracteres, chave repetida, ou `PROCESSOVIVO_AUTH_DISABLED=true` junto com
`PROCESSOVIVO_API_KEYS` preenchida (ambíguo — escolha um dos dois).

**502 nas consultas depois de configurar o DataJud**
Log com `chave pública rejeitada (HTTP 401)` = a chave do CNJ está errada ou foi
rotacionada; pegue a atual na wiki do DataJud. Log com
`limite de requisições excedido` = baixe `DATAJUD_RATE_LIMIT_PER_MINUTE`.

**Requisições caindo a cada redeploy**
Não deveria acontecer: o tini repassa o SIGTERM e o Fastify fecha esperando as
respostas em voo. Se acontecer, confira se o `ENTRYPOINT` do Dockerfile foi
alterado.

---

## Migrar uma instalação que era LexFlow

Até a v0.17.0 o produto se chamava LexFlow, e o nome estava no domínio, nas
variáveis de ambiente, no arquivo do banco e no cookie de sessão. A v0.18.0
renomeia tudo para Processo Vivo. **Faça isto com o serviço no ar; nada aqui
exige parar nada** — mas faça na ordem, porque dois passos podem parecer que os
dados sumiram.

### 1. Tire um backup antes de qualquer coisa

```bash
node dist/main/cli.js backup
```

Ou, se preferir, apenas confirme que a cópia automática de hoje está lá em
`/dados/backups/`. Os dois passos seguintes mexem com o arquivo do banco.

### 2. O arquivo do banco: renomeie o ARQUIVO ou mantenha a variável

Este é o passo que engana. A v0.18.0 mudou o caminho **padrão** para
`/dados/processovivo.db`, mas no Easypanel o caminho vem da variável, então o
padrão não se aplica ao seu serviço. Você tem duas saídas, e as duas funcionam:

- **A mais simples:** não mexa. Deixe `PROCESSOVIVO_DB_PATH=/dados/lexflow.db`.
  O nome do arquivo dentro do volume não aparece para ninguém.
- **A mais limpa:** renomeie o arquivo dentro do volume e só então mude a
  variável. No terminal do contêiner, pelo Easypanel:

  ```bash
  ls /dados
  mv /dados/lexflow.db     /dados/processovivo.db
  mv /dados/lexflow.db-wal /dados/processovivo.db-wal 2>/dev/null
  mv /dados/lexflow.db-shm /dados/processovivo.db-shm 2>/dev/null
  ```

  Os arquivos `-wal` e `-shm` vão junto: eles pertencem ao banco e carregam
  escritas que ainda não foram para o arquivo principal.

> **O que NÃO fazer:** mudar `PROCESSOVIVO_DB_PATH` para um arquivo que não
> existe. O sistema não reclama — ele cria um banco novo e vazio, sobe normal, e
> o advogado entra e encontra o ambiente sem nenhum processo, com os dados dele
> intactos no arquivo ao lado, invisíveis. É o pior modo de falhar que existe
> aqui, porque parece perda de dados e não é.

### 3. O volume: mantenha o nome que já existe

Se o seu mount se chama `lexflow-dados`, **deixe como está**. Renomear o mount
no Easypanel não renomeia o volume: cria um volume novo e vazio, e monta esse.
O nome `processovivo-dados` na seção de Mounts vale para instalação nova.

### 4. As variáveis de ambiente

Renomeie o prefixo de todas: `LEXFLOW_*` → `PROCESSOVIVO_*`.

| Antes | Depois |
|---|---|
| `LEXFLOW_API_KEYS` | `PROCESSOVIVO_API_KEYS` |
| `LEXFLOW_PROVIDER_CHAIN` | `PROCESSOVIVO_PROVIDER_CHAIN` |
| `LEXFLOW_DB_PATH` | `PROCESSOVIVO_DB_PATH` |
| `LEXFLOW_CREDENCIAL_CHAVE` | `PROCESSOVIVO_CREDENCIAL_CHAVE` |
| `LEXFLOW_URL_BASE` | `PROCESSOVIVO_URL_BASE` |
| `LEXFLOW_AUTH_DISABLED` | `PROCESSOVIVO_AUTH_DISABLED` |

**O nome antigo continua funcionando**, de propósito: se uma passar
despercebida, o serviço sobe igual e o log avisa, em `warn`, qual trocar —

```
{"nivel":"warn","msg":"variável de ambiente com nome antigo",
 "antigo":"LEXFLOW_CREDENCIAL_CHAVE","atual":"PROCESSOVIVO_CREDENCIAL_CHAVE"}
```

Se as duas estiverem definidas, vence a NOVA. Isso existe porque cada variável
esquecida falharia de um jeito diferente: sem a chave de API o processo nem
sobe (barulhento, fácil de achar); sem a chave do cofre as peças somem em
silêncio e as rotas passam a responder 501; sem o caminho do banco acontece o
que está no aviso do passo 2.

**Uma coisa que não pode ser reaproveitada de jeito nenhum:** o VALOR de
`LEXFLOW_CREDENCIAL_CHAVE` tem que continuar exatamente o mesmo. É ele que
decifra a senha de tribunal de cada assinante. Copie o valor, não gere outro.

### 5. O domínio

Acrescente `app.processovivo.com.br` na aba Domains e ajuste
`PROCESSOVIVO_URL_BASE` para ele. Mantenha o domínio antigo apontando para o
mesmo serviço por algumas semanas — quem tiver a página aberta ou salva nos
favoritos continua entrando.

### 6. Depois do deploy

O cookie de sessão mudou de nome (`lexflow_sessao` → `processovivo_sessao`), o
que **desconecta todo mundo uma vez**. É esperado: basta entrar de novo. Se você
tiver assinantes, avise antes — um logout sem explicação parece defeito.

Confira, nesta ordem:

```bash
curl -s https://app.processovivo.com.br/health
# {"status":"ok","versao":"0.18.0",...}   ← a versão confirma que o deploy pegou

curl -s https://app.processovivo.com.br/v1/senha/recuperar
# {"disponivel":true}   ← false significa que falta SMTP ou URL_BASE
```

E então, pela interface: entre, veja se a carteira está lá, e **baixe uma peça**.
A peça é o teste que vale, porque é o único que prova que a chave do cofre
continua casando com o banco.

As cópias de backup antigas (`lexflow-<data>.db`) continuam sendo reconhecidas e
podadas normalmente — não precisa apagar nada à mão.

---

## Atualizando de uma versão anterior

### Antes de tudo: confira se os arquivos ocultos estão no repositório

Se você subiu o código pelo **"Add file → Upload files" do GitHub no navegador**,
provavelmente faltam arquivos. O Explorer do Windows esconde tudo que começa com
ponto, então o que você arrastou não incluiu:

| Arquivo | O que acontece sem ele |
|---|---|
| `.gitignore` | **o mais grave** — nada impede o `.env` (com sua chave) e o `node_modules/` de irem para o repositório no próximo commit |
| `.dockerignore` | build mais lento; o contexto inteiro vai para o daemon |
| `.env.example` | some a referência de quais variáveis existem |
| `.github/workflows/ci.yml` | não há CI: erro só aparece no deploy |

Como conferir: no GitHub, digite <kbd>t</kbd> na página do repositório e busque
por `gitignore`. Ou abra
`https://github.com/SEU-USUARIO/processovivo/blob/main/.gitignore` direto — 404
significa que não está lá.

**Se faltar o `.gitignore`, resolva isso antes de qualquer outra coisa.** Sem
ele, um `git add .` distraído publica sua chave de API num repositório — e chave
que entrou no histórico do Git continua lá mesmo depois de apagada num commit
seguinte. Nesse caso, a saída é gerar outra.

### O jeito que resolve de vez: usar Git

O upload pelo navegador não apaga arquivos removidos, não versiona direito e
esconde dotfiles. Vale os cinco minutos de instalar o Git.

1. Instale: <https://git-scm.com/download/win> (aceite os padrões)
2. Descompacte o zip novo **por cima** da sua pasta do projeto, substituindo os
   arquivos. Seu `.env` local não está no zip, então ele sobrevive.
3. No PowerShell, dentro da pasta:

```powershell
git init
git remote add origin https://github.com/SEU-USUARIO/processovivo.git
git fetch origin
git checkout -b main
git add -A
git commit -m "Atualiza para a v0.3.0"
git push -u origin main --force
```

O `--force` aqui é intencional e seguro: o histórico atual é um único commit de
upload, e você está substituindo por um commit completo — com os dotfiles, que é
o ponto. Da segunda vez em diante, `git push` normal.

Confira o resultado: a raiz do repositório deve mostrar `.gitignore`,
`.dockerignore`, `.env.example` e a pasta `.github/`.

Nos próximos ciclos, o fluxo vira:

```powershell
git add -A
git commit -m "o que mudou"
git push
```

E, com o webhook do passo 5 configurado, o Easypanel redeploya sozinho.

### Se preferir continuar pelo navegador

Dá para fazer, mas precisa de um passo extra para os dotfiles:

1. No Explorer: aba **Exibir → Mostrar → Itens ocultos**
2. Arraste os arquivos **e** as pastas, incluindo `.github/`
3. Crie os arquivos que teimarem em não subir pelo próprio GitHub:
   **Add file → Create new file**, digite `.gitignore` no nome e cole o conteúdo

Ainda assim, arquivos que deixaram de existir no projeto continuarão no
repositório — o upload só adiciona e sobrescreve. Por isso o Git é melhor.

### Confirme que o deploy pegou a versão nova

```bash
curl https://processovivo.webmedula.com.br/health
# {"status":"ok","versao":"0.3.0","uptimeSegundos":12}
```

Se o campo `versao` continuar mostrando a anterior, o Easypanel não pegou o
commit novo: verifique o branch configurado na aba Source e rode um Deploy
manual.

---

## Próximos passos depois do primeiro deploy

O cache é em memória — cada contêiner tem o seu, e ele evapora a cada redeploy.
Serve para uma instância. Se você escalar para duas, ou quiser que o cache
sobreviva ao deploy, suba um Redis pelo template do Easypanel e implemente a
porta `Cache` em `infrastructure/cache/RedisCache.ts`: é uma classe nova e uma
linha trocada no composition root. Veja "Como estender" no
[CLAUDE.md](./CLAUDE.md).
