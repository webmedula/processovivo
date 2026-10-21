import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AutorizacaoDoDestinoRevogadaError,
  DestinoIndisponivelError,
  DestinoLimitouError,
  DestinoRecusouError,
  DestinoSemEspacoError,
} from '../../src/domain/errors/index.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { DestinoFalso } from '../helpers/drive.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  PNG_1X1,
  ProvedorDeLoteFalso,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';
import { CODIGO_DO_GOOGLE } from '../helpers/transporteDoDrive.js';

/*
 * v0.49.0 — comprovantes de custo: do servidor ao Drive do advogado, SEM tocar o disco. Drive
 * simulado, arquivos sintéticos, nenhuma rede. A Pasta digital de verdade só é montada porque o Drive
 * exige (a mesma montagem dos testes do Drive das peças).
 */
const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const NUMERO = '9999901-96.2026.8.09.9999';

class LoggerEspiao implements Logger {
  readonly linhas: string[] = [];
  private registrar(m: string, c?: Record<string, unknown>): void {
    this.linhas.push(`${m} ${JSON.stringify(c ?? {})}`);
  }
  debug = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
  info = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
  warn = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
  error = (m: string, c?: Record<string, unknown>): void => this.registrar(m, c);
  child = (): Logger => this;
}

let dir: ReturnType<typeof pastaTemporaria>;
let servidor: FastifyInstance;
let app: Aplicacao;
let destino: DestinoFalso;
let espiao: LoggerEspiao;
let pdf: Uint8Array;

async function montar(comDrive = true): Promise<void> {
  dir = pastaTemporaria();
  destino = new DestinoFalso();
  espiao = new LoggerEspiao();
  pdf = await pdfSintetico(1, 'COMPROVANTE');
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: new ProvedorDeLoteFalso([]),
    leitor: { pasta: dir.caminho },
    comAssinaturas: true,
    agora: () => new Date('2026-10-20T15:00:00.000Z'),
    ...(comDrive
      ? {
          drive: {
            destino,
            esperar: (): Promise<void> => Promise.resolve(),
          },
        }
      : {}),
  });
  servidor = construirServidor(
    { ...app, logger: espiao },
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
      RATE_LIMIT_MAX: '100000',
    } as NodeJS.ProcessEnv),
  );
  // A: plano Peças (inclui salvarNoDrive). B: plano Acompanhamento (não inclui).
  await app.assinaturas.liberar({
    workspace: workspaceDaChave(CHAVE_A),
    plano: 'pecas',
    meses: 1,
  });
  await app.assinaturas.liberar({
    workspace: workspaceDaChave(CHAVE_B),
    plano: 'acompanhamento',
    meses: 1,
  });
}

afterEach(async () => {
  await servidor.close();
  dir.apagar();
});

async function conectar(h = A): Promise<void> {
  const c = await servidor.inject({
    method: 'POST',
    url: '/v1/drive/conexao',
    headers: h,
  });
  const estado = new URL((c.json() as { url: string }).url).searchParams.get(
    'state',
  ) as string;
  const r = await servidor.inject({
    method: 'GET',
    url: `/v1/drive/retorno?code=${CODIGO_DO_GOOGLE}&state=${encodeURIComponent(estado)}`,
  });
  expect(r.headers['location']).toBe('/?drive=ok');
}

async function lancar(h = A): Promise<string> {
  const r = await servidor.inject({
    method: 'POST',
    url: `/v1/processos/${NUMERO}/custos`,
    headers: h,
    payload: {
      data: '2026-10-15',
      descricao: 'Guia de custas',
      categoria: 'CUS-020',
      valorCentavos: 10_000,
      reembolsavel: true,
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

function anexar(
  id: string,
  corpo: Uint8Array | Buffer | string,
  o: { nome?: string; tipo?: string; h?: Record<string, string> } = {},
) {
  return servidor.inject({
    method: 'POST',
    url: `/v1/custos/${id}/comprovantes`,
    headers: {
      ...(o.h ?? A),
      'content-type': o.tipo ?? 'application/pdf',
      'x-nome-do-arquivo': encodeURIComponent(o.nome ?? 'guia.pdf'),
    },
    payload: corpo as Buffer,
  });
}

async function lista(h = A) {
  return (
    await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${NUMERO}/custos`,
      headers: h,
    })
  ).json();
}

const enviosAoGoogle = (): number => destino.contar('enviarArquivo');

describe('Comprovantes — enviar ao Drive do advogado', () => {
  it('guarda o PDF em Processo Vivo/<número>/Custos, devolve o vínculo e conta no lançamento', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const r = await anexar(id, Buffer.from(pdf), { nome: 'Guia de custas 01.pdf' });
    expect(r.statusCode).toBe(201);
    const c = r.json();
    expect(c).toMatchObject({
      nome: 'Guia de custas 01.pdf',
      tipo: 'application/pdf',
      tamanho: pdf.length,
    });
    expect(c.link).toMatch(/^https:\/\/(drive|docs)\.google\.com\//);

    // A estrutura de pastas: Processo Vivo › <número> › Custos — só o número, nenhum nome de cliente.
    const arquivo = destino.envios[0]!;
    expect(arquivo.nome).toBe('Guia de custas 01.pdf');
    const custos = destino.pastas.get(arquivo.paiId)!;
    const processo = destino.pastas.get(custos.paiId!)!;
    const raiz = destino.pastas.get(processo.paiId!)!;
    expect([raiz.nome, processo.nome, custos.nome]).toEqual([
      'Processo Vivo',
      NUMERO,
      'Custos',
    ]);

    const j = await lista();
    expect(j.lancamentos[0].comprovantes).toHaveLength(1);
    expect(j.lancamentos[0].comprovantes[0]).toMatchObject({
      id: c.id,
      nome: 'Guia de custas 01.pdf',
    });
  });

  it('aceita JPEG e PNG, e o nome sai saneado e com a extensão do tipo REAL', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const png = await anexar(id, Buffer.from(PNG_1X1), {
      nome: '..\\..\\recibo?.pdf',
      tipo: 'image/png',
    });
    expect(png.statusCode).toBe(201);
    expect(png.json().nome).toBe('recibo.png');
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(40, 1),
    ]);
    const j = await anexar(id, jpeg, { nome: 'foto.jpeg', tipo: 'image/jpeg' });
    expect(j.statusCode).toBe(201);
    expect(j.json().nome).toBe('foto.jpg');
  });

  it('a segunda subida reaproveita as pastas: não cria Processo Vivo nem Custos de novo', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    await anexar(id, Buffer.from(pdf), { nome: 'a.pdf' });
    const pastasAntes = destino.pastas.size;
    await anexar(id, Buffer.from(pdf), { nome: 'b.pdf' });
    expect(destino.pastas.size).toBe(pastasAntes);
    expect(destino.envios).toHaveLength(2);
  });

  it('o arquivo passa pela memória: nada é gravado em disco (nem na pasta do leitor, nem no tmp)', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    mkdirSync(join(dir.caminho), { recursive: true });
    const arvore = (p: string): string[] =>
      readdirSync(p, { recursive: true }).map(String).sort();
    const antesLeitor = arvore(dir.caminho);
    // O "tmp" do teste é uma pasta PRÓPRIA e vazia: durante o envio, `os.tmpdir()` aponta para ela (lê TMPDIR a cada
    // chamada). Antes o teste comparava o /tmp inteiro do sistema, e outro teste em paralelo (pv-leitor-teste-*) criava
    // e removia pastas ali — falso positivo. Agora só o que ESTE envio gravar poderia aparecer.
    const tmpPropria = mkdtempSync(join(tmpdir(), 'pv-comprovante-isolado-'));
    const tmpAntes = process.env['TMPDIR'];
    process.env['TMPDIR'] = tmpPropria;
    let r: Awaited<ReturnType<typeof anexar>>;
    try {
      r = await anexar(id, Buffer.from(pdf), { nome: 'sigilo-do-cliente.pdf' });
    } finally {
      if (tmpAntes === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = tmpAntes;
    }
    expect(r.statusCode).toBe(201);
    expect(arvore(dir.caminho)).toEqual(antesLeitor);
    expect(readdirSync(tmpPropria)).toEqual([]);
    rmSync(tmpPropria, { recursive: true, force: true });

    // E o código não importa nada de disco nos arquivos que tratam o comprovante.
    for (const f of [
      '../../src/application/services/ServicoCustos.ts',
      '../../src/application/services/ServicoCustosPorCliente.ts',
      '../../src/domain/entities/Comprovante.ts',
      '../../src/main/http/rotas/custos.ts',
    ]) {
      expect(readFileSync(resolve(__dirname, f), 'utf8'), f).not.toMatch(
        /from 'node:(fs|os|path|child_process)'|writeFile|createWriteStream|tmpdir/,
      );
    }
  });

  it('nome de arquivo e tamanho nunca vão a log', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    await anexar(id, Buffer.from(pdf), { nome: 'NOME-SECRETO-DO-CLIENTE.pdf' });
    await anexar(id, Buffer.from('lixo'), { nome: 'OUTRO-NOME-SECRETO.pdf' });
    const tudo = espiao.linhas.join('\n');
    expect(tudo).not.toContain('SECRETO');
    expect(tudo).not.toContain(String(pdf.length));
  });
});

describe('Comprovantes — o que NÃO é aceito', () => {
  it('arquivo cujo tipo REAL não é PDF, JPEG nem PNG é recusado ANTES do Google, mesmo com extensão e tipo de PDF', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const executavel = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.alloc(60),
    ]);
    for (const [corpo, nome, tipo] of [
      [executavel, 'recibo.pdf', 'application/pdf'],
      [
        Buffer.from('<html><script>alert(1)</script></html>'),
        'guia.pdf',
        'application/pdf',
      ],
      [Buffer.from('GIF89a....'), 'imagem.png', 'image/png'],
      [Buffer.from(PNG_1X1), 'recibo.pdf', 'application/pdf'],
    ] as const) {
      const r = await anexar(id, corpo, { nome, tipo });
      expect(r.statusCode, nome).toBe(415);
      expect(r.json().detalhes).toEqual({ motivo: 'tipo_nao_aceito' });
      expect(r.json().mensagem).not.toContain(nome);
    }
    expect(enviosAoGoogle()).toBe(0);
    expect((await lista()).lancamentos[0].comprovantes).toEqual([]);
  });

  it('corpo vazio, ou JSON no lugar do arquivo, é recusado com mensagem clara', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const vazio = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/comprovantes`,
      headers: { ...A, 'content-type': 'application/pdf' },
    });
    expect([400, 415]).toContain(vazio.statusCode);
    const json = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/comprovantes`,
      headers: { ...A, 'content-type': 'application/json' },
      payload: { arquivo: 'x' },
    });
    expect([400, 415]).toContain(json.statusCode);
    expect(json.json().mensagem).toBeTruthy();
    expect(enviosAoGoogle()).toBe(0);
  });

  it('5 MB exatos passam; 1 byte a mais é recusado com 413 e o Google nem é chamado', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const base = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from(pdf.subarray(0, 8)).copy(base);
    const ok = await anexar(id, base, { nome: 'cinco.pdf' });
    expect(ok.statusCode).toBe(201);
    const acima = Buffer.alloc(5 * 1024 * 1024 + 1);
    Buffer.from(pdf.subarray(0, 8)).copy(acima);
    const r = await anexar(id, acima, { nome: 'seis.pdf' });
    expect(r.statusCode).toBe(413);
    expect(r.json().detalhes).toEqual({ motivo: 'arquivo_grande' });
    expect(enviosAoGoogle()).toBe(1);
  });

  it('um arquivo MUITO maior que o teto também é barrado pelo servidor (413, JSON)', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const r = await anexar(id, Buffer.alloc(6 * 1024 * 1024, 0x25), {
      nome: 'enorme.pdf',
    });
    expect(r.statusCode).toBe(413);
    expect(r.headers['content-type']).toContain('application/json');
    expect(enviosAoGoogle()).toBe(0);
  });

  it('o 6º comprovante é recusado (422, limite "comprovantes"); remover abre vaga', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await anexar(id, Buffer.from(pdf), { nome: `g${i}.pdf` });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id as string);
    }
    const sexto = await anexar(id, Buffer.from(pdf), { nome: 'g6.pdf' });
    expect(sexto.statusCode).toBe(422);
    expect(sexto.json().detalhes).toEqual({ limite: 'comprovantes' });
    expect(enviosAoGoogle()).toBe(5);
    await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/comprovantes/${ids[0]}`,
      headers: A,
    });
    expect((await anexar(id, Buffer.from(pdf), { nome: 'g7.pdf' })).statusCode).toBe(201);
  });

  it('lançamento cancelado não recebe comprovante até ser reativado', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/cancelamento`,
      headers: A,
      payload: {},
    });
    expect((await anexar(id, Buffer.from(pdf))).statusCode).toBe(400);
    expect(enviosAoGoogle()).toBe(0);
  });
});

describe('Comprovantes — Drive indisponível para esta conta (zero chamadas ao Google)', () => {
  it('Drive não conectado: 409 nao_conectado, com a explicação do caminho', async () => {
    await montar();
    const id = await lancar();
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes).toEqual({ motivo: 'nao_conectado' });
    expect(r.json().mensagem).toBe(
      'Conecte o Google Drive em Meus acessos para anexar comprovantes.',
    );
    expect(destino.chamadas).toEqual([]);
  });

  it('plano sem o recurso salvarNoDrive: 403 sem_plano, sem erro técnico e sem chamar o Google', async () => {
    await montar();
    await conectar();
    const idB = await lancar(B);
    const r = await anexar(idB, Buffer.from(pdf), { h: B });
    expect(r.statusCode).toBe(403);
    expect(r.json().detalhes).toEqual({ motivo: 'sem_plano' });
    expect(enviosAoGoogle()).toBe(0);
  });

  it('Drive desligado no servidor: 403, sem tocar em nada', async () => {
    await montar(false);
    const id = await lancar();
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(403);
    expect(r.json().mensagem).toContain('Google Drive');
    expect((await lista()).lancamentos[0].comprovantes).toEqual([]);
  });

  it('autorização revogada: 409 precisa_reconectar, e a conexão fica marcada para reconectar', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    destino.vencerAutorizacaoAntes = 5;
    destino.falhaNaRenovacao = new AutorizacaoDoDestinoRevogadaError('revogada', 'x');
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes).toEqual({ motivo: 'precisa_reconectar' });
    const d = (await servidor.inject({ url: '/v1/drive', headers: A })).json();
    expect(d.estado).toBe('precisa_reconectar');
    // Agora, sem insistir: a próxima tentativa nem chama o Google.
    const antes = destino.chamadas.length;
    const outra = await anexar(id, Buffer.from(pdf));
    expect(outra.statusCode).toBe(409);
    expect(destino.chamadas.length).toBe(antes);
  });

  it('token de acesso vencido é renovado UMA vez e o envio segue', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    destino.vencerAutorizacaoAntes = 1;
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(201);
    // Uma tentativa recusada por token vencido e UMA repetição com o token renovado.
    expect(enviosAoGoogle()).toBe(2);
  });
});

describe('Comprovantes — o Google recusou', () => {
  const casos: Array<[string, Error, number, string]> = [
    ['Drive cheio', new DestinoSemEspacoError(), 422, 'drive_cheio'],
    ['limite de uso', new DestinoLimitouError(120_000), 429, 'limite_de_uso'],
    ['recusa definitiva', new DestinoRecusouError(403), 422, 'recusado'],
  ];
  it.each(casos)(
    '%s: resposta clara, JSON, sem texto do Google',
    async (_n, erro, status, motivo) => {
      await montar();
      await conectar();
      const id = await lancar();
      destino.falhasDeEnvio = [erro];
      const r = await anexar(id, Buffer.from(pdf));
      expect(r.statusCode).toBe(status);
      expect(r.json().detalhes).toEqual({ motivo });
      expect(r.body).not.toContain('HTTP 403');
      expect((await lista()).lancamentos[0].comprovantes).toEqual([]);
    },
  );

  it('fora do ar: repete com espera limitada (4 tentativas) e depois responde 503', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    destino.falhasDeEnvio = Array.from(
      { length: 10 },
      () => new DestinoIndisponivelError(503),
    );
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(503);
    expect(r.json().detalhes).toEqual({ motivo: 'drive_indisponivel' });
    expect(enviosAoGoogle()).toBe(4);
  });

  it('um tropeço passageiro (5xx uma vez) é absorvido pela repetição', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    destino.falhasDeEnvio = [new DestinoIndisponivelError(503)];
    const r = await anexar(id, Buffer.from(pdf));
    expect(r.statusCode).toBe(201);
    expect(enviosAoGoogle()).toBe(2);
  });
});

describe('Comprovantes — remover só o vínculo', () => {
  it('o arquivo continua no Drive: o sistema não apaga, não renomeia e não lista nada lá', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const c = (await anexar(id, Buffer.from(pdf), { nome: 'guia.pdf' })).json();
    const chamadasAntes = destino.chamadas.length;
    const r = await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/comprovantes/${c.id}`,
      headers: A,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ removido: true, arquivoContinuaNoDrive: true });
    // Nenhuma chamada ao Google, e o arquivo segue lá, fora da lixeira.
    expect(destino.chamadas.length).toBe(chamadasAntes);
    expect(destino.envios[0]!.trashed).toBe(false);
    expect((await lista()).lancamentos[0].comprovantes).toEqual([]);
    // Remover de novo: não existe mais.
    expect(
      (
        await servidor.inject({
          method: 'DELETE',
          url: `/v1/custos/${id}/comprovantes/${c.id}`,
          headers: A,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('o histórico registra "anexou" e "removeu", sem nome de arquivo', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const c = (
      await anexar(id, Buffer.from(pdf), { nome: 'NOME-NO-HISTORICO.pdf' })
    ).json();
    await servidor.inject({
      method: 'DELETE',
      url: `/v1/custos/${id}/comprovantes/${c.id}`,
      headers: A,
    });
    const h = (
      await servidor.inject({ url: `/v1/custos/${id}/historico`, headers: A })
    ).json();
    expect(h.eventos.map((e: { operacao: string }) => e.operacao)).toEqual([
      'criou',
      'anexou',
      'removeu',
    ]);
    expect(JSON.stringify(h)).not.toContain('NOME-NO-HISTORICO');
  });
});

describe('Comprovantes — isolamento e plano', () => {
  it('uma conta não anexa, remove nem vê comprovante de outra (404 igual a "não existe")', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const c = (await anexar(id, Buffer.from(pdf))).json();
    // B (outro workspace, sem Drive): 404 antes de qualquer outra coisa.
    expect((await anexar(id, Buffer.from(pdf), { h: B })).statusCode).toBe(404);
    expect(
      (
        await servidor.inject({
          method: 'DELETE',
          url: `/v1/custos/${id}/comprovantes/${c.id}`,
          headers: B,
        })
      ).statusCode,
    ).toBe(404);
    expect((await lista(B)).lancamentos).toEqual([]);
    expect(JSON.stringify(await lista(B))).not.toContain(c.id);
    expect((await lista()).lancamentos[0].comprovantes).toHaveLength(1);
  });

  it('sem credencial é 401; sem o recurso custosDoProcesso no plano é 403', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    const sem = await servidor.inject({
      method: 'POST',
      url: `/v1/custos/${id}/comprovantes`,
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from(pdf),
    });
    expect(sem.statusCode).toBe(401);

    const codigo = (await app.repositorioAssinaturas.porWorkspace(
      workspaceDaChave(CHAVE_A),
    ))!.plano;
    const plano = await app.planos.porCodigo(codigo);
    await app.planos.atualizar(codigo, {
      recursos: plano.recursos.filter((r) => r !== 'custosDoProcesso'),
    });
    expect((await anexar(id, Buffer.from(pdf))).statusCode).toBe(403);
    expect(enviosAoGoogle()).toBe(0);
  });

  it('o limite de taxa do upload barra o laço (429)', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    let ultimo = 0;
    for (let i = 0; i < 24; i++) {
      ultimo = (await anexar(id, Buffer.from('lixo'), { nome: 'x.pdf' })).statusCode;
    }
    expect(ultimo).toBe(429);
  });
});

describe('Comprovantes — nos relatórios, só o número', () => {
  function textoDoPdf(bytes: Uint8Array): string {
    const arquivo = join(dir.caminho, `rel-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(arquivo, bytes);
    return execFileSync('pdftotext', ['-layout', arquivo, '-'], {
      encoding: 'utf8',
    }).replace(/\s+/g, ' ');
  }

  it('o PDF por processo, o consolidado e o CSV dizem "Comprovantes: N", sem nome de arquivo nem link do Drive', async () => {
    await montar();
    await conectar();
    const id = await lancar();
    await anexar(id, Buffer.from(pdf), { nome: 'NOME-DO-ARQUIVO-A.pdf' });
    await anexar(id, Buffer.from(pdf), { nome: 'NOME-DO-ARQUIVO-B.pdf' });
    await app.acompanhamento.acompanhar(workspaceDaChave(CHAVE_A), NUMERO);
    await app.acompanhamento.rotular(
      workspaceDaChave(CHAVE_A),
      NUMERO,
      'Cliente Sintético',
    );

    const processo = await servidor.inject({
      url: `/v1/processos/${NUMERO}/custos/prestacao.pdf`,
      headers: A,
    });
    const t1 = textoDoPdf(new Uint8Array(processo.rawPayload));
    expect(t1).toContain('Comprovantes: 2');

    const consolidado = await servidor.inject({
      url: `/v1/custos/clientes/prestacao.pdf?cliente=${encodeURIComponent('cliente sintetico')}`,
      headers: A,
    });
    expect(consolidado.statusCode).toBe(200);
    const t2 = textoDoPdf(new Uint8Array(consolidado.rawPayload));
    expect(t2).toContain('Comprovantes: 2');

    const csv = await servidor.inject({
      url: `/v1/processos/${NUMERO}/custos/lancamentos.csv`,
      headers: A,
    });
    const linha = csv.body.split('\r\n')[1]!.split(';');
    expect(linha[10]).toBe('2');

    for (const saida of [t1, t2, csv.body, processo.body, consolidado.body]) {
      expect(saida).not.toContain('NOME-DO-ARQUIVO');
      expect(saida).not.toContain('drive.google.com');
    }
  });
});
