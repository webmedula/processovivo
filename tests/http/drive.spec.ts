import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Logger } from '../../src/domain/ports/Logger.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { DestinoFalso } from '../helpers/drive.js';
import { ProviderFalso } from '../helpers/fabricas.js';
import {
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';
import {
  CODIGO_DO_GOOGLE,
  TOKEN_DE_ACESSO,
  TOKEN_DE_RENOVACAO,
} from '../helpers/transporteDoDrive.js';

/* Rotas do Google Drive: Pasta digital de verdade, Drive de mentira, nenhuma rede. */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const CHAVE_B = 'chave-do-advogado-b-1234567890';
const A = { 'x-api-key': CHAVE_A };
const B = { 'x-api-key': CHAVE_B };
const PASTA_DRIVE = `/v1/processos/${PROCESSO_TJGO}/pasta/drive`;

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
let provedor: ProvedorDeLoteFalso;
let destino: DestinoFalso;
let espiao: LoggerEspiao;

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: `${CHAVE_A},${CHAVE_B}`,
    RATE_LIMIT_MAX: '100000',
  } as NodeJS.ProcessEnv);
}

async function montar(comDrive: boolean): Promise<void> {
  dir = pastaTemporaria();
  destino = new DestinoFalso();
  espiao = new LoggerEspiao();
  provedor = new ProvedorDeLoteFalso([
    {
      id: 'a',
      rotulo: 'Petição inicial',
      bytes: await pdfSintetico(2, 'A'),
      movimento: 1,
    },
    { id: 'b', rotulo: 'Procuração', bytes: await pdfSintetico(1, 'B'), movimento: 1 },
    { id: 'c', rotulo: 'Contestação', bytes: await pdfSintetico(1, 'C'), movimento: 2 },
    {
      id: 's',
      rotulo: 'Laudo sigiloso',
      bytes: await pdfSintetico(1, 'S'),
      nivelSigilo: 1,
    },
  ]);
  app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    provedorDePecas: provedor,
    leitor: { pasta: dir.caminho },
    comAssinaturas: true,
    ...(comDrive
      ? {
          drive: {
            destino,
            // O envio espera a Pasta entregar a peça pedida: tempo de verdade, curtíssimo.
            esperar: (ms: number) =>
              new Promise<void>((r) => setTimeout(r, Math.min(ms, 3))),
          },
        }
      : {}),
  });
  servidor = construirServidor({ ...app, logger: espiao }, config());
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
  for (const h of [A, B]) {
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: h,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
  }
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
    headers: h,
  });
  expect(r.headers['location']).toBe('/?drive=ok');
}

async function carregarPecas(h = A): Promise<void> {
  const r = await servidor.inject({
    url: `/v1/processos/${PROCESSO_TJGO}/pecas`,
    headers: h,
  });
  expect(r.statusCode).toBe(200);
}

async function guardar(ids: string[], h = A): Promise<void> {
  for (const id of ids) {
    await servidor.inject({
      method: 'POST',
      url: `/v1/processos/${PROCESSO_TJGO}/pasta/pecas/${id}`,
      headers: h,
    });
  }
  await app.pasta?.aguardarOciosa();
}

async function enviar(corpo: unknown, h = A) {
  return servidor.inject({
    method: 'POST',
    url: PASTA_DRIVE,
    headers: h,
    payload: corpo as Record<string, unknown>,
  });
}

async function esperarEnvio(id: string, h = A): Promise<Record<string, unknown>> {
  await app.drive?.aguardarOcioso();
  const r = await servidor.inject({ url: `/v1/drive/jobs/${id}`, headers: h });
  return r.json() as Record<string, unknown>;
}

describe('Drive desligado (padrão)', () => {
  beforeEach(() => montar(false));

  it('GET /v1/drive diz `habilitado: false` — é como a tela sabe que não mostra nada', async () => {
    const r = await servidor.inject({ url: '/v1/drive', headers: A });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ habilitado: false });
  });

  it('todas as outras respondem 501, e o Google não é chamado', async () => {
    for (const [metodo, url] of [
      ['POST', '/v1/drive/conexao'],
      ['GET', '/v1/drive/retorno?code=x&state=y'],
      ['DELETE', '/v1/drive'],
      ['GET', '/v1/drive/jobs/x'],
      ['DELETE', '/v1/drive/jobs/x'],
    ] as const) {
      const r = await servidor.inject({ method: metodo, url, headers: A });
      expect(r.statusCode, `${metodo} ${url}`).toBe(501);
    }
    expect((await enviar({ todas: true })).statusCode).toBe(501);
    expect(destino.chamadas).toEqual([]);
  });
});

describe('Drive habilitado', () => {
  beforeEach(() => montar(true));

  it('exige autenticação como qualquer rota de dados', async () => {
    expect((await servidor.inject({ url: '/v1/drive' })).statusCode).toBe(401);
    expect(
      (await servidor.inject({ method: 'POST', url: '/v1/drive/conexao' })).statusCode,
    ).toBe(401);
    expect(
      (await servidor.inject({ url: '/v1/drive/retorno?code=x&state=y' })).statusCode,
    ).toBe(401);
    expect(
      (
        await servidor.inject({
          method: 'POST',
          url: PASTA_DRIVE,
          payload: { todas: true },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('desconectado: mostra o estado e NÃO chama o Google', async () => {
    const r = await servidor.inject({ url: '/v1/drive', headers: A });
    expect(r.json()).toMatchObject({
      habilitado: true,
      plano: true,
      estado: 'desconectado',
      linkDaPastaRaiz: null,
      envioAtivo: null,
    });
    expect(destino.chamadas).toEqual([]);
  });

  it('sem o recurso no plano (Acompanhamento): aviso de plano, 403 e ZERO chamadas ao Google', async () => {
    const v = await servidor.inject({ url: '/v1/drive', headers: B });
    expect(v.json()).toMatchObject({
      habilitado: true,
      plano: false,
      estado: 'desconectado',
    });
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: B,
    });
    expect(c.statusCode).toBe(403);
    expect(c.json()).toMatchObject({
      erro: 'DRIVE_RECUSADO',
      detalhes: { motivo: 'sem_plano' },
    });
    expect((await enviar({ todas: true }, B)).statusCode).toBe(403);
    expect(destino.chamadas).toEqual([]);
  });

  it('chave de API SEM assinatura também não passa (como a IA): não há conta Google atrás dela', async () => {
    const chaveC = 'chave-sem-assinatura-1234567890-abc';
    const s2 = construirServidor(
      { ...app, logger: espiao },
      carregarConfig({
        PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
        LOG_LEVEL: 'silent',
        CACHE_ENABLED: 'false',
        PROCESSOVIVO_API_KEYS: chaveC,
      } as NodeJS.ProcessEnv),
    );
    const r = await s2.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: { 'x-api-key': chaveC },
    });
    expect(r.statusCode).toBe(403);
    await s2.close();
  });

  it('conectar: a URL de autorização sai com state, e o retorno redireciona para a tela — sem token na URL', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: A,
    });
    expect(c.statusCode).toBe(200);
    const url = new URL((c.json() as { url: string }).url);
    const estado = url.searchParams.get('state') as string;
    expect(estado.length).toBeGreaterThan(20);

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/drive/retorno?code=${CODIGO_DO_GOOGLE}&state=${encodeURIComponent(estado)}`,
      headers: A,
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers['location']).toBe('/?drive=ok');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.body).not.toContain(TOKEN_DE_ACESSO);
    expect(String(r.headers['location'])).not.toContain(CODIGO_DO_GOOGLE);

    const v = (await servidor.inject({ url: '/v1/drive', headers: A })).json() as Record<
      string,
      unknown
    >;
    expect(v['estado']).toBe('conectado');
    expect(String(v['linkDaPastaRaiz'])).toMatch(/^https:\/\/drive\.google\.com\//);
    // Nenhuma resposta traz token.
    expect(JSON.stringify(v)).not.toContain(TOKEN_DE_ACESSO);
    expect(JSON.stringify(v)).not.toContain(TOKEN_DE_RENOVACAO);
  });

  it('retorno com state reutilizado, de outra conta ou inventado volta para a tela com motivo curto', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: A,
    });
    const estado = new URL((c.json() as { url: string }).url).searchParams.get(
      'state',
    ) as string;
    const q = (e: string) => `/v1/drive/retorno?code=x&state=${encodeURIComponent(e)}`;

    const deOutra = await servidor.inject({ url: q(estado), headers: B });
    expect(deOutra.headers['location']).toBe('/?drive=erro&motivo=estado_invalido');
    const inventado = await servidor.inject({ url: q('a.b'), headers: A });
    expect(inventado.headers['location']).toBe('/?drive=erro&motivo=estado_invalido');
    expect(destino.contar('concluirConexao')).toBe(0);

    await servidor.inject({ url: q(estado), headers: A });
    const repetido = await servidor.inject({ url: q(estado), headers: A });
    expect(repetido.headers['location']).toBe('/?drive=erro&motivo=estado_invalido');
    expect(destino.contar('concluirConexao')).toBe(1);
  });

  it('o advogado cancelou no Google (`error=access_denied`): volta sem drama e o state é gasto', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: A,
    });
    const estado = new URL((c.json() as { url: string }).url).searchParams.get(
      'state',
    ) as string;
    const r = await servidor.inject({
      url: `/v1/drive/retorno?error=access_denied&state=${encodeURIComponent(estado)}`,
      headers: A,
    });
    expect(r.headers['location']).toBe('/?drive=erro&motivo=negado');
    expect(destino.contar('concluirConexao')).toBe(0);
    const depois = await servidor.inject({
      url: `/v1/drive/retorno?code=x&state=${encodeURIComponent(estado)}`,
      headers: A,
    });
    expect(depois.headers['location']).toBe('/?drive=erro&motivo=estado_invalido');
  });

  it('o log de acesso nunca leva o código nem o state do retorno (só o caminho)', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/drive/conexao',
      headers: A,
    });
    const estado = new URL((c.json() as { url: string }).url).searchParams.get(
      'state',
    ) as string;
    await servidor.inject({
      url: `/v1/drive/retorno?code=${CODIGO_DO_GOOGLE}&state=${encodeURIComponent(estado)}`,
      headers: A,
    });
    const tudo = espiao.linhas.join('\n');
    expect(tudo).toContain('"rota":"/v1/drive/retorno"');
    for (const proibido of [
      CODIGO_DO_GOOGLE,
      estado,
      'code=',
      TOKEN_DE_ACESSO,
      TOKEN_DE_RENOVACAO,
    ]) {
      expect(tudo).not.toContain(proibido);
    }
  });

  it('desconectar (DELETE /v1/drive): apaga a autorização e volta a "desconectado"', async () => {
    await conectar();
    const r = await servidor.inject({ method: 'DELETE', url: '/v1/drive', headers: A });
    expect(r.json()).toEqual({ desconectado: true });
    expect(destino.contar('desconectar')).toBe(1);
    expect(
      (
        (await servidor.inject({ url: '/v1/drive', headers: A })).json() as {
          estado: string;
        }
      ).estado,
    ).toBe('desconectado');
  });

  describe('o envio', () => {
    beforeEach(async () => {
      await conectar();
      await carregarPecas();
    });

    it('NENHUMA rota aceita texto, nome de arquivo ou conteúdo do cliente: campo a mais é 400', async () => {
      await guardar(['a']);
      for (const corpo of [
        { pecas: ['a'], nome: 'meu-arquivo.pdf' },
        { pecas: ['a'], conteudo: 'AAAA' },
        { todas: true, pasta: 'outra' },
        {},
        { pecas: [] },
        { todas: false },
        { todas: true, pecas: ['a'] },
        { pecas: [''] },
      ]) {
        const r = await enviar(corpo);
        expect(r.statusCode, JSON.stringify(corpo)).toBe(400);
      }
      expect(destino.contar('enviarArquivo')).toBe(0);
    });

    it('peça que não está na pasta deste workspace: 404, sem chamar o Google', async () => {
      const antes = destino.chamadas.length;
      const r = await enviar({ pecas: ['nao-existe'] });
      expect(r.statusCode).toBe(404);
      expect(destino.chamadas.length).toBe(antes);
    });

    it('envia as marcadas: 202, progresso por GET, arquivos no Drive e o link da pasta', async () => {
      await guardar(['a', 'b']);
      const r = await enviar({ pecas: ['a', 'b'] });
      expect(r.statusCode).toBe(202);
      const id = (r.json() as { id: string }).id;
      const fim = await esperarEnvio(id);
      expect(fim).toMatchObject({
        estado: 'concluido',
        total: 2,
        progresso: { enviadas: 2, jaEstavam: 0, falhas: 0 },
        sigilosasForaDoEnvio: 0,
      });
      expect(String(fim['linkDaPasta'])).toMatch(/^https:\/\/drive\.google\.com\//);
      expect(destino.envios).toHaveLength(2);
      expect(JSON.stringify(fim)).not.toContain(TOKEN_DE_ACESSO);
    });

    it('reenviar não duplica: "já estavam"', async () => {
      await guardar(['a', 'b']);
      await esperarEnvio(
        ((await enviar({ pecas: ['a', 'b'] })).json() as { id: string }).id,
      );
      const fim = await esperarEnvio(
        ((await enviar({ pecas: ['a', 'b'] })).json() as { id: string }).id,
      );
      expect(fim['progresso']).toMatchObject({ enviadas: 0, jaEstavam: 2 });
      expect(destino.envios).toHaveLength(2);
    });

    it('"todas": as sigilosas ficam de fora e o resultado diz quantas', async () => {
      await guardar(['a', 'b', 'c']);
      const fim = await esperarEnvio(
        ((await enviar({ todas: true })).json() as { id: string }).id,
      );
      expect(fim['sigilosasForaDoEnvio']).toBe(1);
      expect(fim['progresso']).toMatchObject({ enviadas: 3 });
      expect(destino.envios.some((e) => e.nome.includes('sigiloso'))).toBe(false);
    });

    it('peça sigilosa pedida pelo id: fica de fora; só ela = 409 e nenhuma chamada', async () => {
      const antes = destino.chamadas.length;
      const r = await enviar({ pecas: ['s'] });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ detalhes: { motivo: 'nada_para_enviar' } });
      expect(destino.chamadas.length).toBe(antes);
    });

    it('peça que venceu da guarda: é pedida ao tribunal pelo caminho da Pasta, uma vez, e vai ao Drive', async () => {
      const lotesAntes = provedor.chamadas.filter((c) => c.tipo === 'lote').length;
      const r = await enviar({ pecas: ['a'] });
      const fim = await esperarEnvio((r.json() as { id: string }).id);
      expect(fim['progresso']).toMatchObject({ enviadas: 1 });
      expect(provedor.chamadas.filter((c) => c.tipo === 'lote').length - lotesAntes).toBe(
        1,
      );
    });

    it('peças que já estão na guarda NÃO vão ao tribunal', async () => {
      await guardar(['a', 'b']);
      const antes = provedor.chamadas.length;
      await esperarEnvio(
        ((await enviar({ pecas: ['a', 'b'] })).json() as { id: string }).id,
      );
      expect(provedor.chamadas.length).toBe(antes);
    });

    it('um envio por vez no workspace: o segundo clique é 409 e o primeiro continua', async () => {
      await guardar(['a', 'b']);
      const primeiro = await enviar({ pecas: ['a', 'b'] });
      const segundo = await enviar({ pecas: ['a'] });
      expect(segundo.statusCode).toBe(409);
      expect(segundo.json()).toMatchObject({ detalhes: { motivo: 'job_em_andamento' } });
      const fim = await esperarEnvio((primeiro.json() as { id: string }).id);
      expect(fim['estado']).toBe('concluido');
    });

    it('GET /v1/drive devolve o envio ativo, para a tela reatar o progresso depois de recarregar', async () => {
      await guardar(['a']);
      const r = await enviar({ pecas: ['a'] });
      const id = (r.json() as { id: string }).id;
      const v = (await servidor.inject({ url: '/v1/drive', headers: A })).json() as {
        envioAtivo: { id: string } | null;
      };
      // Pode já ter terminado (o dublê é rápido); se não, o ativo é este.
      if (v.envioAtivo) expect(v.envioAtivo.id).toBe(id);
      await esperarEnvio(id);
    });

    it('isolamento: o envio de A não existe para B (404 igual ao de "não existe"), e B não o cancela', async () => {
      await guardar(['a']);
      const id = ((await enviar({ pecas: ['a'] })).json() as { id: string }).id;
      await esperarEnvio(id);
      const deOutro = await servidor.inject({ url: `/v1/drive/jobs/${id}`, headers: B });
      const inexistente = await servidor.inject({
        url: '/v1/drive/jobs/nao-existe',
        headers: B,
      });
      expect(deOutro.statusCode).toBe(404);
      expect(deOutro.json()).toEqual(inexistente.json());
      expect(
        (
          await servidor.inject({
            method: 'DELETE',
            url: `/v1/drive/jobs/${id}`,
            headers: B,
          })
        ).statusCode,
      ).toBe(404);
    });

    it('cancelar: DELETE no envio o encerra', async () => {
      await guardar(['a', 'b', 'c']);
      const id = ((await enviar({ pecas: ['a', 'b', 'c'] })).json() as { id: string }).id;
      const r = await servidor.inject({
        method: 'DELETE',
        url: `/v1/drive/jobs/${id}`,
        headers: A,
      });
      expect(r.statusCode).toBe(200);
      const fim = await esperarEnvio(id);
      expect(['cancelado', 'concluido']).toContain(fim['estado']);
    });
  });

  it('processo em segredo de justiça: 403 e ZERO chamadas ao Drive', async () => {
    provedor.nivelSigiloDoProcesso = 1;
    await conectar();
    await carregarPecas();
    const antes = destino.chamadas.length;
    const r = await enviar({ todas: true });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ erro: 'SEGREDO_DE_JUSTICA_NAO_GUARDADO' });
    expect(destino.chamadas.length).toBe(antes);
  });

  it('sem conectar: 409 `nao_conectado`, e o Google não é chamado', async () => {
    await carregarPecas();
    const r = await enviar({ todas: true });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ detalhes: { motivo: 'nao_conectado' } });
    expect(destino.chamadas).toEqual([]);
  });

  it('sem carregar as peças do processo: 409 da Pasta (a lista ainda não existe)', async () => {
    await conectar();
    const r = await enviar({ todas: true });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ erro: 'LISTAGEM_DA_PASTA_AUSENTE' });
  });
});
