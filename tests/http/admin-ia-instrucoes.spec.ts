import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import type { FuncaoDeIa } from '../../src/domain/entities/ControleDaIa.js';
import type { ExecutorDaVerificacaoDeInstrucoes } from '../../src/domain/ports/InstrucoesDeIa.js';
import type { ResultadoDaExecucaoDoTeste } from '../../src/domain/ports/ModelosDeIa.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorFalso, NOME_DA_PARTE, TEXTO_DO_ATO } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import { ATOS_DO_RESUMO, ResumidorFalso } from '../helpers/resumoIa.js';
import { ATUAL, catalogoDeTeste, metricas } from '../helpers/modelosDeIa.js';

/*
 * As instruções de interpretação ponta a ponta pelo /admin (Fase C): só o operador, o ciclo
 * editar → prévia → rascunho → experimentar → publicar → reverter, as recusas em português e o
 * conjunto de verificação opcional. Nenhuma resposta leva e-mail, chave de API ou workspace.
 */

const CHAVE_A = 'chave-da-advogada-a-1234567890';
const WS_A = workspaceDaChave(CHAVE_A);
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const EMAIL_DA_CONTA = 'maria.sintetica@escritorio.test';
const basic = (u: string, s: string): string =>
  'Basic ' + Buffer.from(`${u}:${s}`).toString('base64');
const ADMIN = { authorization: basic(ADMIN_USUARIO, ADMIN_SENHA) };
const AGORA = new Date('2026-10-26T12:00:00.000Z');
const DIGITOS = NUMERO_TJSP_A.replace(/\D/g, '');
const ATO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};
const CHAVE_DO_ATO = chaveDaMovimentacao(ATO);

class ExecutorDeInstrucoesFalso implements ExecutorDaVerificacaoDeInstrucoes {
  execucoes = 0;
  estimarInstrucoes() {
    return { chamadas: 40, custoEstimadoUsd: 0.1 };
  }
  async executarInstrucoes(p: {
    aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste> {
    this.execucoes += 1;
    p.aoChamar();
    return {
      tipo: 'ok',
      candidato: metricas({ modelo: ATUAL, violacoes: 1 }),
      referencia: metricas({ modelo: ATUAL }),
      gastoUsd: 0.07,
      tetoAtingido: false,
    };
  }
}

let app: Aplicacao;
let servidor: FastifyInstance;
let analisador: AnalisadorFalso;
let resumidor: ResumidorFalso;
let executor: ExecutorDeInstrucoesFalso;
let tudo: string[];

function config() {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    CACHE_ENABLED: 'false',
    PROCESSOVIVO_API_KEYS: CHAVE_A,
    RATE_LIMIT_MAX: '1000',
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv);
}

async function montar(
  opcoes: { dono?: boolean; verificacao?: boolean } = {},
): Promise<void> {
  analisador = new AnalisadorFalso();
  resumidor = new ResumidorFalso();
  executor = new ExecutorDeInstrucoesFalso();
  let n = 0;
  app = aplicacaoDeTeste(
    [
      new ProviderFalso({
        nome: 'falso',
        porNumero: async () =>
          umProcesso({
            partes: [
              { nome: NOME_DA_PARTE, polo: 'ATIVO', tipoPessoa: 'FISICA', advogados: [] },
            ],
            movimentacoes: [ATO, ...ATOS_DO_RESUMO.slice(1)],
          }),
      }),
    ],
    {
      agora: () => AGORA,
      admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
      analiseIa: { analisador },
      resumoIa: { resumidor },
      modelosDeIa: {
        catalogo: catalogoDeTeste(),
        doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
      },
      instrucoesDeIa: {
        ...(opcoes.verificacao === false ? {} : { executor }),
        contaDoDono: async () => (opcoes.dono === false ? undefined : WS_A),
        novoId: () => `v-${++n}`,
      },
    },
  );
  servidor = construirServidor(app, config());
  tudo = [];
  await app.acompanhamento.acompanhar(WS_A, NUMERO_TJSP_A);
}

const chamar = async (
  metodo: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = ADMIN,
) => {
  const r = await servidor.inject({
    method: metodo,
    url,
    headers,
    ...(payload ? { payload } : {}),
  });
  tudo.push(r.body);
  return r;
};
const visao = async () => (await chamar('GET', '/admin/api/ia/instrucoes')).json();
const daFuncao = async (f: FuncaoDeIa) =>
  (await visao()).funcoes.find((x: { funcao: string }) => x.funcao === f);
const rascunho = (f: FuncaoDeIa, texto: string, observacao = '') =>
  chamar('PUT', `/admin/api/ia/instrucoes/${f}/rascunho`, { texto, observacao });
const publicar = (f: FuncaoDeIa, versao: number, confirmado = true) =>
  chamar('POST', `/admin/api/ia/instrucoes/${f}/publicar`, { versao, confirmado });

afterEach(async () => {
  await servidor.close();
});

describe('quem acessa', () => {
  beforeEach(() => montar());

  const ROTAS = [
    ['GET', '/admin/api/ia/instrucoes'],
    ['PUT', '/admin/api/ia/instrucoes/ato/rascunho'],
    ['POST', '/admin/api/ia/instrucoes/ato/previa'],
    ['GET', '/admin/api/ia/instrucoes/ato/versoes/1'],
    ['GET', '/admin/api/ia/instrucoes/ato/diff?de=0&para=1'],
    ['POST', '/admin/api/ia/instrucoes/ato/publicar'],
    ['POST', '/admin/api/ia/instrucoes/ato/reverter'],
    ['GET', '/admin/api/ia/instrucoes/ato/erros'],
    ['POST', '/admin/api/ia/instrucoes/ato/experimentar'],
    ['GET', '/admin/api/ia/experimento/processos'],
    ['GET', `/admin/api/ia/experimento/processos/${DIGITOS}/atos`],
    ['GET', `/admin/api/ia/experimento/processos/${DIGITOS}/pecas`],
    ['POST', '/admin/api/ia/instrucoes/ato/verificacao/estimativa'],
    ['POST', '/admin/api/ia/instrucoes/ato/verificacao'],
    ['GET', '/admin/api/ia/verificacoes/v-1'],
    ['POST', '/admin/api/ia/verificacoes/v-1/cancelar'],
  ] as const;

  it('sem credencial: 401 com o desafio do /admin em toda rota nova, e nada é enviado ao modelo', async () => {
    for (const [metodo, url] of ROTAS) {
      const r = await servidor.inject({
        method: metodo,
        url,
        payload: { texto: 'x', confirmado: true },
      });
      expect(r.statusCode, `${metodo} ${url}`).toBe(401);
      expect(r.headers['www-authenticate'], `${metodo} ${url}`).toMatch(/^Basic/);
    }
    expect(analisador.chamadas).toBe(0);
    expect(executor.execucoes).toBe(0);
  });

  it('a chave de API de uma integração e a sessão de um assinante NÃO abrem nada (e nada é gravado)', async () => {
    const c = await servidor.inject({
      method: 'POST',
      url: '/v1/contas',
      payload: {
        nome: 'Maria Silva',
        email: EMAIL_DA_CONTA,
        senha: 'uma-senha-boa-o-bastante',
      },
    });
    const cookie = String(c.headers['set-cookie']).split(';')[0] as string;
    for (const h of [{ 'x-api-key': CHAVE_A }, { cookie }]) {
      for (const [metodo, url] of ROTAS) {
        const r = await servidor.inject({
          method: metodo,
          url,
          headers: h,
          payload: { texto: 'x', confirmado: true },
        });
        expect(r.statusCode, `${metodo} ${url}`).toBe(401);
      }
    }
    expect((await daFuncao('ato')).rascunho).toBeNull();
    expect(analisador.chamadas).toBe(0);
  });

  it('o /v1 do assinante não tem rota de instruções', async () => {
    const r = await servidor.inject({
      method: 'PUT',
      url: '/v1/ia/instrucoes/ato/rascunho',
      headers: { 'x-api-key': CHAVE_A },
      payload: { texto: 'x' },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe('o que a tela lê', () => {
  beforeEach(() => montar());

  it('por função: a versão em produção como +e0, os limites, o que é fixo e o que reverte', async () => {
    const v = await visao();
    expect(v.limites).toEqual({ texto: 4000, observacao: 200 });
    expect(v.verificacao).toMatchObject({
      disponivel: true,
      tetoDaRodadaUsd: 1,
      emAndamento: null,
    });
    expect(v.funcoes.map((f: { funcao: string }) => f.funcao)).toEqual([
      'ato',
      'resumo',
      'peca',
    ]);
    const ato = v.funcoes[0];
    expect(ato).toMatchObject({
      versaoDoPrompt: 'ato-1.2.0',
      versaoEfetiva: 'ato-1.2.0+e0',
      versaoGravada: 'ato-1.2.0',
      publicada: { versao: 0, rotulo: '+e0', texto: '' },
      podeReverter: false,
      rascunho: null,
      historico: [],
      leituraFalhou: false,
      experimentoDisponivel: true,
    });
    // não há serviço de peça montado neste teste: o experimento daquela função não existe
    expect(v.funcoes[2].experimentoDisponivel).toBe(false);
    expect(v.funcoes[1]).toMatchObject({ versaoDoPrompt: 'resumo-1.2.0' });
    expect(v.funcoes[2]).toMatchObject({ versaoDoPrompt: 'peca-1.1.0' });
  });

  it('sem executor (IA desligada) a verificação diz que está indisponível e o resto do painel segue', async () => {
    await servidor.close();
    await montar({ verificacao: false });
    expect((await visao()).verificacao.disponivel).toBe(false);
    const r = await chamar('POST', '/admin/api/ia/instrucoes/ato/verificacao', {
      confirmado: true,
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().detalhes.motivo).toBe('verificacao_indisponivel');
    expect((await rascunho('ato', 'Segue funcionando.')).statusCode).toBe(200);
  });
});

describe('o ciclo: rascunho → prévia → publicar → reverter', () => {
  beforeEach(() => montar());

  it('salvar rascunho não muda nada em produção; publicar muda a versão; reverter volta', async () => {
    const r = await rascunho('ato', 'Destaque o prazo escrito.', 'primeira tentativa');
    expect(r.statusCode).toBe(200);
    let ato = await daFuncao('ato');
    expect(ato.rascunho).toMatchObject({
      versao: 1,
      rotulo: '+e1',
      texto: 'Destaque o prazo escrito.',
      observacao: 'primeira tentativa',
    });
    expect(ato.publicada.versao).toBe(0);

    const p = await publicar('ato', 1);
    expect(p.statusCode).toBe(200);
    ato = await daFuncao('ato');
    expect(ato).toMatchObject({
      versaoEfetiva: 'ato-1.2.0+e1',
      versaoGravada: 'ato-1.2.0+e1',
      publicada: { versao: 1, rotulo: '+e1', texto: 'Destaque o prazo escrito.' },
      podeReverter: true,
      reverteParaRotulo: '+e0',
      rascunho: null,
    });
    expect(ato.historico[0]).toMatchObject({
      versao: 1,
      estado: 'publicada',
      observacao: 'primeira tentativa',
    });
    expect(ato.historico[0].publicadoPor).toMatch(/^[0-9a-f]{8}$/);

    // a PRÓXIMA análise de qualquer usuário já usa a instrução nova
    await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
    const a = await servidor.inject({
      method: 'POST',
      url: `/v1/acompanhamentos/${DIGITOS}/analise`,
      headers: { 'x-api-key': CHAVE_A },
      payload: { chaveDoAto: CHAVE_DO_ATO },
    });
    expect(a.statusCode).toBe(200);
    expect(a.json().versaoPrompt).toBe('ato-1.2.0+e1');
    expect(analisador.pedidos[0]?.sistema).toContain('Destaque o prazo escrito.');

    const rev = await chamar('POST', '/admin/api/ia/instrucoes/ato/reverter', {
      confirmado: true,
    });
    expect(rev.statusCode).toBe(200);
    expect(rev.json().funcoes[0]).toMatchObject({
      versaoEfetiva: 'ato-1.2.0+e0',
      podeReverter: false,
    });
    const b = await servidor.inject({
      method: 'POST',
      url: `/v1/acompanhamentos/${DIGITOS}/analise`,
      headers: { 'x-api-key': CHAVE_A },
      payload: { chaveDoAto: CHAVE_DO_ATO },
    });
    expect(b.json().versaoPrompt).toBe('ato-1.2.0');
    expect(analisador.pedidos[1]?.sistema).not.toContain('Destaque o prazo escrito.');
  });

  it('a prévia monta fixa + bloco + lembrete com exemplo fictício, sem gravar', async () => {
    const r = await chamar('POST', '/admin/api/ia/instrucoes/resumo/previa', {
      texto: 'Seja breve.',
    });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p.fixa).toContain('REGRAS:');
    expect(p.editavel).toContain('Seja breve.');
    expect(p.lembrete).toContain('LEMBRETE FINAL');
    expect(p.montado.startsWith(p.fixa)).toBe(true);
    expect(p.exemplo).toContain('exemplo fictício');
    expect(p.formato).toContain('JSON');
    expect((await daFuncao('resumo')).rascunho).toBeNull();
    const vazio = (
      await chamar('POST', '/admin/api/ia/instrucoes/resumo/previa', { texto: '' })
    ).json();
    expect(vazio.montado).toBe(vazio.fixa);
  });

  it('versões e diff entre quaisquer duas (0 = padrão)', async () => {
    await rascunho('ato', 'linha a\nlinha b');
    await publicar('ato', 1);
    await rascunho('ato', 'linha a\nlinha c');
    await publicar('ato', 2);
    expect(
      (await chamar('GET', '/admin/api/ia/instrucoes/ato/versoes/1')).json(),
    ).toEqual({
      versao: 1,
      texto: 'linha a\nlinha b',
    });
    const d = (
      await chamar('GET', '/admin/api/ia/instrucoes/ato/diff?de=1&para=2')
    ).json();
    expect(d.linhas.map((l: { tipo: string }) => l.tipo)).toEqual([
      'igual',
      'removida',
      'adicionada',
    ]);
    const d0 = (
      await chamar('GET', '/admin/api/ia/instrucoes/ato/diff?de=0&para=1')
    ).json();
    expect(d0.linhas.every((l: { tipo: string }) => l.tipo === 'adicionada')).toBe(true);
    expect(
      (await chamar('GET', '/admin/api/ia/instrucoes/ato/versoes/9')).statusCode,
    ).toBe(404);
    expect(
      (await chamar('GET', '/admin/api/ia/instrucoes/ato/diff?de=x&para=1')).statusCode,
    ).toBe(400);
  });

  it('recusas: sem confirmação, sem rascunho, rascunho que mudou, texto vazio e texto grande — com frase nossa', async () => {
    expect((await publicar('ato', 1, false)).json().detalhes.motivo).toBe(
      'confirmacao_necessaria',
    );
    expect((await publicar('ato', 1)).json().detalhes.motivo).toBe(
      'rascunho_inexistente',
    );
    await rascunho('ato', 'Algo');
    expect((await publicar('ato', 5)).json().detalhes.motivo).toBe('rascunho_mudou');
    await rascunho('resumo', '   ');
    const vazio = await publicar('resumo', 1);
    expect(vazio.statusCode).toBe(422);
    expect(vazio.json().detalhes.motivo).toBe('texto_vazio');
    expect(vazio.json().mensagem).toContain('Reverter');
    const grande = await rascunho('ato', 'a'.repeat(4001));
    expect(grande.statusCode).toBe(422);
    expect(grande.json().detalhes.motivo).toBe('texto_grande');
    expect(grande.body).not.toContain('aaaaaaaaaa');
    expect(
      (
        await chamar('POST', '/admin/api/ia/instrucoes/ato/reverter', {
          confirmado: true,
        })
      ).json().detalhes.motivo,
    ).toBe('nada_para_reverter');
    expect((await rascunho('forjada' as FuncaoDeIa, 'x')).json().detalhes.motivo).toBe(
      'funcao_desconhecida',
    );
    // nada foi publicado em nenhuma das recusas
    expect((await daFuncao('ato')).publicada.versao).toBe(0);
  });

  it('corpo com campo a mais: 400', async () => {
    const r = await chamar('PUT', '/admin/api/ia/instrucoes/ato/rascunho', {
      texto: 'x',
      extra: 1,
    });
    expect(r.statusCode).toBe(400);
  });

  it('o registro de mudanças do painel mostra publicar e reverter, sem o texto', async () => {
    await rascunho('ato', 'Texto sintético do operador.');
    await publicar('ato', 1);
    await chamar('POST', '/admin/api/ia/instrucoes/ato/reverter', { confirmado: true });
    const painel = (await chamar('GET', '/admin/api/ia?periodo=hoje')).json();
    const tipos = painel.alteracoes.map((a: { tipo: string }) => a.tipo);
    expect(tipos).toEqual(
      expect.arrayContaining(['instrucoes_publicadas', 'instrucoes_revertidas']),
    );
    expect(JSON.stringify(painel)).not.toContain('sintético do operador');
  });
});

describe('experimentar num caso real', () => {
  beforeEach(() => montar());

  it('lista os processos da conta do dono e os atos, e roda publicada × rascunho lado a lado', async () => {
    await rascunho('ato', 'Instrução publicada.');
    await publicar('ato', 1);
    await rascunho('ato', 'Instrução do rascunho.');
    const lista = (await chamar('GET', '/admin/api/ia/experimento/processos')).json();
    expect(lista.processos).toHaveLength(1);
    expect(lista.processos[0]).toMatchObject({
      numero: DIGITOS,
      numeroFormatado: NUMERO_TJSP_A,
      sigiloso: false,
    });
    const atos = (
      await chamar('GET', `/admin/api/ia/experimento/processos/${DIGITOS}/atos`)
    ).json();
    expect(
      atos.atos.some((a: { chaveDoAto: string }) => a.chaveDoAto === CHAVE_DO_ATO),
    ).toBe(true);

    const r = await chamar('POST', '/admin/api/ia/instrucoes/ato/experimentar', {
      numero: DIGITOS,
      chaveDoAto: CHAVE_DO_ATO,
      texto: 'Instrução do rascunho.',
    });
    expect(r.statusCode).toBe(200);
    const e = r.json();
    expect(e.funcao).toBe('ato');
    expect(
      e.bracos.map((b: { rotulo: string; versaoRotulo: string }) => [
        b.rotulo,
        b.versaoRotulo,
      ]),
    ).toEqual([
      ['publicada', '+e1'],
      ['rascunho', '+e2'],
    ]);
    for (const b of e.bracos) {
      expect(b).toMatchObject({ estado: 'ok', verificado: true, modelo: 'modelo/teste' });
      expect(b.secoes.map((s: { titulo: string }) => s.titulo)).toEqual(
        expect.arrayContaining(['O que o ato diz', 'Providências']),
      );
      expect(b.citacoes.validas).toBeGreaterThan(0);
      expect(b.latenciaMs).toBeGreaterThanOrEqual(0);
      expect(b.custoUsd).toBe(0.0002);
    }
    expect(JSON.stringify(e.bracos[0].secoes)).toContain('Mariana'); // o dono vê o caso dele
    // as duas chamadas levaram cada uma a SUA instrução
    const sistemas = analisador.pedidos.map((p) => p.sistema);
    expect(sistemas.some((s) => s.includes('Instrução publicada.'))).toBe(true);
    expect(sistemas.some((s) => s.includes('Instrução do rascunho.'))).toBe(true);
    // e NADA foi gravado: o painel de IA não conta nenhuma análise, e o registro é só o das mudanças
    const painel = (await chamar('GET', '/admin/api/ia?periodo=30d')).json();
    expect(painel.funcoes[0].analises).toBe(0);
    expect(JSON.stringify(painel)).not.toContain('Mariana');
  });

  it('resumo: roda e devolve as seções Situação e O que pede providência', async () => {
    await rascunho('resumo', 'Texto do rascunho.');
    const r = await chamar('POST', '/admin/api/ia/instrucoes/resumo/experimentar', {
      numero: DIGITOS,
    });
    expect(r.statusCode).toBe(200);
    const b = r.json().bracos[1];
    expect(b).toMatchObject({ estado: 'ok', verificado: true });
    expect(b.secoes.map((s: { titulo: string }) => s.titulo)).toContain('Situação');
  });

  it('sem a conta do dono: 409 com frase nossa, e nada é enviado', async () => {
    await servidor.close();
    await montar({ dono: false });
    const r = await chamar('GET', '/admin/api/ia/experimento/processos');
    expect(r.statusCode).toBe(409);
    expect(r.json().detalhes.motivo).toBe('conta_do_dono_ausente');
    const e = await chamar('POST', '/admin/api/ia/instrucoes/ato/experimentar', {
      numero: DIGITOS,
      chaveDoAto: CHAVE_DO_ATO,
    });
    expect(e.statusCode).toBe(409);
    expect(analisador.chamadas).toBe(0);
  });

  it('caso inválido (ato sem chave) é 400; ato que não existe é 409 do serviço de IA; função sem serviço é 503', async () => {
    expect(
      (
        await chamar('POST', '/admin/api/ia/instrucoes/ato/experimentar', {
          numero: DIGITOS,
        })
      ).statusCode,
    ).toBe(400);
    const naoAchou = await chamar('POST', '/admin/api/ia/instrucoes/ato/experimentar', {
      numero: DIGITOS,
      chaveDoAto: 'inexistente',
    });
    expect(naoAchou.json().detalhes.motivo).toBe('ato_nao_encontrado');
    const peca = await chamar('POST', '/admin/api/ia/instrucoes/peca/experimentar', {
      numero: DIGITOS,
      pecaId: 'p1',
    });
    expect(peca.statusCode).toBe(503);
    expect(peca.json().detalhes.motivo).toBe('experimento_indisponivel');
    expect(analisador.chamadas).toBe(0);
  });
});

describe('conjunto de verificação (opcional, nunca bloqueia)', () => {
  beforeEach(() => montar());

  it('estimar → confirmar → rodar → consultar, com avisos de piora que não impedem de publicar', async () => {
    await rascunho('ato', 'Rascunho para verificar.');
    const est = (
      await chamar('POST', '/admin/api/ia/instrucoes/ato/verificacao/estimativa', {})
    ).json();
    expect(est).toMatchObject({
      chamadas: 40,
      custoEstimadoUsd: 0.1,
      tetoUsd: 1,
      acimaDoTeto: false,
      modelo: ATUAL,
    });
    expect(
      (await chamar('POST', '/admin/api/ia/instrucoes/ato/verificacao', {})).json()
        .detalhes.motivo,
    ).toBe('confirmacao_necessaria');
    const ini = await chamar('POST', '/admin/api/ia/instrucoes/ato/verificacao', {
      confirmado: true,
    });
    expect(ini.statusCode).toBe(202);
    await app.verificacaoDeInstrucoes.aguardarFim();
    const v = (await chamar('GET', `/admin/api/ia/verificacoes/${ini.json().id}`)).json();
    expect(v).toMatchObject({
      estado: 'concluido',
      funcao: 'ato',
      rascunho: '+e1',
      modelo: ATUAL,
    });
    expect(v.comparacao.map((l: { chave: string }) => l.chave)).toContain('citacao');
    expect(v.avisos.some((a: { gravidade: string }) => a.gravidade === 'grave')).toBe(
      true,
    );
    expect(v.avisos[0].frase).toContain('rascunho');
    // aparece na visão geral
    expect((await daFuncao('ato')).ultimaVerificacao.id).toBe(v.id);
    // e publicar segue livre, mesmo com aviso grave
    expect((await publicar('ato', 1)).statusCode).toBe(200);
    // não existe verificação "de modelo" por este caminho
    expect(
      (await chamar('GET', '/admin/api/ia/verificacoes/nao-existe')).statusCode,
    ).toBe(404);
  });

  it('a Fase B não enxerga a verificação das instruções', async () => {
    await rascunho('ato', 'Rascunho para verificar.');
    const ini = await chamar('POST', '/admin/api/ia/instrucoes/ato/verificacao', {
      confirmado: true,
    });
    await app.verificacaoDeInstrucoes.aguardarFim();
    const m = (await chamar('GET', '/admin/api/ia/modelos')).json();
    expect(m.emAndamento).toBeNull();
    expect(m.funcoes[0].ultimoTeste).toBeNull();
    const pub = await chamar('POST', '/admin/api/ia/modelos/ato/publicar', {
      testeId: ini.json().id,
      confirmado: true,
    });
    expect(pub.statusCode).toBe(404);
  });
});

describe('onde a IA erra', () => {
  beforeEach(() => montar());

  it('lista os polegares para baixo por edição, com o motivo e sem conteúdo', async () => {
    await app.assinaturas.liberar({ workspace: WS_A, plano: 'ia', meses: 1 });
    const a = await servidor.inject({
      method: 'POST',
      url: `/v1/acompanhamentos/${DIGITOS}/analise`,
      headers: { 'x-api-key': CHAVE_A },
      payload: { chaveDoAto: CHAVE_DO_ATO },
    });
    const avaliar = await servidor.inject({
      method: 'POST',
      url: `/v1/analises/${a.json().id}/avaliacao`,
      headers: { 'x-api-key': CHAVE_A },
      payload: { avaliacao: 'errado', motivo: 'erro_de_fato' },
    });
    expect(avaliar.statusCode).toBeLessThan(300);
    const r = (await chamar('GET', '/admin/api/ia/instrucoes/ato/erros')).json();
    expect(r.atual).toMatchObject({ edicao: 0, rotulo: '+e0', analises: 1, erradas: 1 });
    expect(r.recentes).toHaveLength(1);
    expect(r.recentes[0]).toMatchObject({
      versao: 'ato-1.2.0+e0',
      avaliacao: 'errado',
      motivo: 'erro_de_fato',
      motivoRotulo: 'erro de fato',
    });
    expect(JSON.stringify(r)).not.toContain('Mariana');
    expect(JSON.stringify(r)).not.toContain(WS_A);
  });
});

it('nenhuma resposta leva e-mail, chave de API, senha ou o workspace inteiro', async () => {
  await montar();
  await rascunho('ato', 'Instrução qualquer.');
  await visao();
  await chamar('GET', '/admin/api/ia/experimento/processos');
  await chamar('GET', '/admin/api/ia/instrucoes/ato/erros');
  const texto = tudo.join('\n');
  for (const proibido of [CHAVE_A, WS_A, ADMIN_SENHA, '@escritorio.test']) {
    expect(texto).not.toContain(proibido);
  }
});
