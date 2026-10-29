/// <reference lib="dom" />
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Dialog, Locator, Page } from 'playwright-core';
import AxeBuilder from 'axe-core';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { chaveDaMovimentacao } from '../../src/domain/entities/Acompanhamento.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';
import type { ExecutorDaVerificacaoDeInstrucoes } from '../../src/domain/ports/InstrucoesDeIa.js';
import type { ResultadoDaExecucaoDoTeste } from '../../src/domain/ports/ModelosDeIa.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { workspaceDaChave } from '../../src/main/http/chaves.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { AnalisadorFalso, NOME_DA_PARTE, TEXTO_DO_ATO } from '../helpers/analiseIa.js';
import { NUMERO_TJSP_A, ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import { ATUAL, catalogoDeTeste, metricas } from '../helpers/modelosDeIa.js';
import { ATOS_DO_RESUMO, ResumidorFalso } from '../helpers/resumoIa.js';
import { CHROMIUM } from './ambiente.js';

/*
 * A seção "Instruções de interpretação" da tela "IA" do /admin NUM NAVEGADOR (Fase C, v0.61.0): o servidor, o
 * /admin e os serviços são os reais; os modelos e o executor da verificação são dublês (nenhuma rede).
 * Mede o ciclo completo (editar, salvar rascunho, prévia, experimentar lado a lado, publicar, reverter, comparar),
 * o aviso de rascunho não salvo, o conjunto de verificação opcional, "onde a IA erra", o teclado, os temas claro e
 * escuro (axe) e as seis larguras sem rolagem horizontal. Texto, nomes e números dos casos são inventados.
 */
const sem = CHROMIUM === undefined;
const CHAVE = 'chave-do-teste-do-admin-instrucoes-1234567890';
const WS = workspaceDaChave(CHAVE);
const ADMIN_USUARIO = 'joao';
const ADMIN_SENHA = 'uma-senha-administrativa-bem-forte';
const LARGURAS = [1920, 1366, 1280, 1024, 768, 390];
const AGORA = new Date('2026-10-26T12:00:00.000Z');
const DIGITOS = NUMERO_TJSP_A.replace(/\D/g, '');
const ATO: Movimentacao = {
  data: new Date('2026-10-05T12:00:00.000Z'),
  titulo: 'Despacho',
  idExterno: 'djen:900',
  conteudo: TEXTO_DO_ATO,
};
const CHAVE_DO_ATO = chaveDaMovimentacao(ATO);
const INSTRUCAO_UM = 'Destaque sempre o prazo escrito no ato.\nSeja breve.';
const INSTRUCAO_DOIS =
  'Destaque sempre o prazo escrito no ato.\nSeja bem mais breve e cite a parte.';

const esperar = (f: () => Promise<void>): Promise<void> =>
  vi.waitFor(f, { timeout: 8000, interval: 50 });
const textoContem = (l: Locator, t: string): Promise<void> =>
  esperar(async () => expect(await l.innerText()).toContain(t));

interface ViolacaoAxe {
  id: string;
  nodes: Array<{ target: string[] }>;
}
interface AxeNaPagina {
  axe: { run(raiz: Element, o: object): Promise<{ violations: ViolacaoAxe[] }> };
}

class ExecutorDeInstrucoesFalso implements ExecutorDaVerificacaoDeInstrucoes {
  execucoes = 0;
  chamadasFeitas = 0;
  portao: Promise<void> | undefined;
  resultado: ResultadoDaExecucaoDoTeste = {
    tipo: 'ok',
    candidato: metricas({ modelo: ATUAL }),
    referencia: metricas({ modelo: ATUAL }),
    gastoUsd: 0.07,
    tetoAtingido: false,
  };
  estimarInstrucoes() {
    return { chamadas: 40, custoEstimadoUsd: 0.1 };
  }
  async executarInstrucoes(p: {
    aoChamar: () => void;
  }): Promise<ResultadoDaExecucaoDoTeste> {
    this.execucoes += 1;
    for (let i = 0; i < this.chamadasFeitas; i++) p.aoChamar();
    if (this.portao) await this.portao;
    return this.resultado;
  }
}

describe.skipIf(sem)(
  'instruções de interpretação na tela "IA" do /admin, no navegador',
  { timeout: 120_000 },
  () => {
    let browser: Browser;
    let servidor: FastifyInstance;
    let app: Aplicacao;
    let analisador: AnalisadorFalso;
    let resumidor: ResumidorFalso;
    let executor: ExecutorDeInstrucoesFalso;
    let url: string;
    let ctx: BrowserContext;
    let page: Page;

    async function subir(comDono = true): Promise<void> {
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
                  {
                    nome: NOME_DA_PARTE,
                    polo: 'ATIVO',
                    tipoPessoa: 'FISICA',
                    advogados: [],
                  },
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
            executor,
            contaDoDono: async () => (comDono ? WS : undefined),
            novoId: () => `v-${++n}`,
          },
        },
      );
      servidor = construirServidor(
        app,
        carregarConfig({
          PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
          LOG_LEVEL: 'silent',
          CACHE_ENABLED: 'false',
          PROCESSOVIVO_API_KEYS: CHAVE,
          RATE_LIMIT_MAX: '100000',
        } as NodeJS.ProcessEnv),
      );
      await app.acompanhamento.acompanhar(WS, NUMERO_TJSP_A);
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    }

    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: CHROMIUM as string,
        args: ['--no-sandbox'],
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    beforeEach(() => subir());
    afterEach(async () => {
      await ctx?.close();
      await servidor.close();
    });

    async function abrir(
      opcoes: { largura?: number; escuro?: boolean } = {},
    ): Promise<void> {
      ctx = await browser.newContext({
        viewport: { width: opcoes.largura ?? 1280, height: 900 },
        colorScheme: opcoes.escuro ? 'dark' : 'light',
        httpCredentials: { username: ADMIN_USUARIO, password: ADMIN_SENHA },
      });
      page = await ctx.newPage();
      await page.goto(`${url}/admin`);
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.getByRole('heading', { level: 1, name: 'IA' }).waitFor();
      await page.locator('#ia-i-texto').waitFor();
    }
    const secao = (): Locator => page.locator('[data-ia-instrucoes]');
    const foco = (): Promise<string | undefined> =>
      page.evaluate(() => document.activeElement?.id);
    const admin = (): Record<string, string> => ({
      authorization:
        'Basic ' + Buffer.from(`${ADMIN_USUARIO}:${ADMIN_SENHA}`).toString('base64'),
    });
    const visao = async () =>
      (
        await servidor.inject({ url: '/admin/api/ia/instrucoes', headers: admin() })
      ).json();

    async function escreverESalvar(texto: string): Promise<void> {
      await page.locator('#ia-i-texto').fill(texto);
      await page.locator('#ia-i-salvar').click();
      await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
    }

    it('abre no padrão (+e0): editor vazio, tudo que depende de rascunho ou de publicação desabilitado, e a fronteira fixo × editável dita', async () => {
      await abrir();
      const t = await secao().innerText();
      expect(t).toContain('Instruções de interpretação');
      expect(t).toContain('ficam no código e não mudam por aqui');
      expect(t).toContain('Não cole aqui texto de processos reais');
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e0');
      await textoContem(page.locator('#ia-i-versao'), 'prompt padrão do sistema (+e0)');
      expect(await page.locator('#ia-i-texto').inputValue()).toBe('');
      expect(await page.locator('#ia-i-contador').innerText()).toContain(
        '0 de 4.000 caracteres',
      );
      expect(await page.locator('#ia-i-salvar').isDisabled()).toBe(true);
      expect(await page.locator('#ia-i-publicar').isDisabled()).toBe(true);
      expect(await page.locator('#ia-i-reverter').isDisabled()).toBe(true);
      expect(await page.locator('[role="tab"]').allInnerTexts()).toEqual([
        'Análise de ato +e0',
        'Resumo do processo +e0',
        'Análise de peça +e0',
      ]);
    });

    it('ciclo completo: escrever, salvar rascunho, ver o prompt montado, experimentar lado a lado, publicar e reverter', async () => {
      await abrir();
      // escrever: contador, selo "não salvas" e botão de salvar reagem na hora
      await page.locator('#ia-i-texto').fill(INSTRUCAO_UM);
      await textoContem(page.locator('#ia-i-sujo'), 'Alterações não salvas');
      await textoContem(
        page.locator('#ia-i-contador'),
        `${INSTRUCAO_UM.length} de 4.000`,
      );
      expect(await page.locator('#ia-i-salvar').isDisabled()).toBe(false);
      expect(await page.locator('#ia-i-publicar').isDisabled()).toBe(true);
      await textoContem(
        page.locator('#ia-i-pub-ajuda'),
        'Escreva a instrução e salve o rascunho',
      );
      await page.locator('#ia-i-obs').fill('Primeira tentativa');
      await page.locator('#ia-i-salvar').click();
      await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo · Rascunho salvo.');
      expect((await visao()).funcoes[0].rascunho).toMatchObject({
        versao: 1,
        texto: INSTRUCAO_UM,
        observacao: 'Primeira tentativa',
      });
      // nada mudou em produção
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e0');

      // prévia do prompt montado: fixa → sua instrução → lembrete → formato → exemplo fictício
      await page.locator('#ia-i-previa-bt').click();
      await textoContem(
        page.locator('#ia-i-previa'),
        '1. Parte fixa (código, não editável)',
      );
      const previa = await page.locator('#ia-i-previa').innerText();
      expect(previa.indexOf('1. Parte fixa')).toBeLessThan(
        previa.indexOf('2. A sua instrução'),
      );
      expect(previa.indexOf('2. A sua instrução')).toBeLessThan(
        previa.indexOf('3. Lembrete final'),
      );
      expect(previa.indexOf('3. Lembrete final')).toBeLessThan(
        previa.indexOf('4. Formato da resposta'),
      );
      expect(await page.locator('#ia-i-p-edit').innerText()).toContain(
        'Destaque sempre o prazo escrito no ato.',
      );
      expect(await page.locator('#ia-i-p-lemb').innerText()).toContain('LEMBRETE FINAL');
      expect(await page.locator('#ia-i-p-exem').innerText()).toContain(
        'exemplo fictício',
      );
      await page.locator('#ia-i-previa-fechar').click();
      expect(await foco()).toBe('ia-i-previa-bt');
      expect(await page.locator('#ia-i-previa').count()).toBe(0);

      // publicar a primeira versão (um clique + confirmação) para ter "publicada" × "rascunho" no experimento
      await page.locator('#ia-i-publicar').click();
      expect(await foco()).toBe('ia-i-pub-ok');
      await page.locator('#ia-i-pub-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
      await textoContem(
        page.locator('#ia-live'),
        'A próxima análise já usa esta versão.',
      );
      expect(await foco()).toBe('ia-i-reverter');
      expect(await page.locator('[role="tab"]').first().innerText()).toContain('+e1');

      // novo rascunho (e2) e experimento num caso real da conta do dono
      await escreverESalvar(INSTRUCAO_DOIS);
      await page.locator('#ia-i-exp-bt').click();
      await page.locator('#ia-i-exp-proc').waitFor();
      expect(await page.locator('#ia-i-exp-proc option').allInnerTexts()).toEqual([
        'Escolha um processo',
        expect.stringContaining(NUMERO_TJSP_A),
      ]);
      expect(await page.locator('#ia-i-exp-rodar').isDisabled()).toBe(true);
      await page.locator('#ia-i-exp-proc').selectOption(DIGITOS);
      await page.locator('#ia-i-exp-ato').waitFor();
      const atos = await page.locator('#ia-i-exp-ato option').allInnerTexts();
      expect(atos.some((a) => a.includes('Despacho'))).toBe(true);
      expect(atos.some((a) => a.includes('sem texto suficiente'))).toBe(true);
      await page.locator('#ia-i-exp-ato').selectOption(CHAVE_DO_ATO);
      await page.locator('#ia-i-exp-rodar').click();
      await page.locator('#ia-i-lado').waitFor();
      const lado = page.locator('#ia-i-lado');
      await textoContem(lado, 'Instrução publicada +e1');
      await textoContem(lado, 'Rascunho +e2');
      expect(await lado.locator('.ia-i-col').count()).toBe(2);
      const col = await lado.locator('.ia-i-col').first().innerText();
      expect(col).toContain('✓ Verificada');
      expect(col).toContain('O que o ato diz');
      expect(col).toContain('Citação:');
      expect(col).toContain('se manifeste sobre o laudo pericial');
      expect(col).toContain('Descartado pela verificação');
      expect(col).toContain('Nada foi descartado.');
      expect(col).toContain('US$ 0,00020');
      expect(col).toContain('modelo/teste');
      // cada lado foi à IA com a SUA instrução, e o caso é o mesmo
      expect(
        analisador.pedidos.map((p) => p.sistema).some((s) => s.includes('Seja breve.')),
      ).toBe(true);
      expect(
        analisador.pedidos
          .map((p) => p.sistema)
          .some((s) => s.includes('Seja bem mais breve')),
      ).toBe(true);
      // "experimentar em outro caso" limpa o caso, NÃO o rascunho
      await page.locator('#ia-i-exp-outro').click();
      expect(await page.locator('#ia-i-lado').count()).toBe(0);
      expect(await page.locator('#ia-i-exp-proc').inputValue()).toBe('');
      expect(await page.locator('#ia-i-texto').inputValue()).toBe(INSTRUCAO_DOIS);
      await page.locator('#ia-i-exp-fechar').click();
      expect(await foco()).toBe('ia-i-exp-bt');
      // o experimento não gravou nada: nenhuma análise no painel
      const painel = (
        await servidor.inject({ url: '/admin/api/ia?periodo=30d', headers: admin() })
      ).json();
      expect(painel.funcoes[0].analises).toBe(0);

      // publicar a segunda, comparar no histórico e reverter
      await page.locator('#ia-i-publicar').click();
      await page.locator('#ia-i-pub-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e2');
      await page.locator('#ia-i-hist-bt').click();
      await textoContem(page.locator('#ia-i-hist'), '+e2');
      await textoContem(page.locator('#ia-i-hist'), 'em uso');
      await textoContem(page.locator('#ia-i-hist'), 'Primeira tentativa');
      await page.locator('#ia-i-diff-de').selectOption('1');
      await page.locator('#ia-i-diff-para').selectOption('2');
      await page.locator('#ia-i-diff-ir').click();
      await page.locator('#ia-i-diff').waitFor();
      const diff = await page.locator('#ia-i-diff').innerText();
      expect(diff).toContain('Removida:');
      expect(diff).toContain('Adicionada:');
      expect(diff).toContain('Seja breve.');
      expect(diff).toContain('Seja bem mais breve e cite a parte.');
      expect(diff).toContain('Destaque sempre o prazo escrito no ato.');
      // contra o padrão tudo é adicionado
      await page.locator('#ia-i-diff-de').selectOption('0');
      await page.locator('#ia-i-diff-ir').click();
      await textoContem(page.locator('#ia-i-diff-t'), '+e0 → +e2');

      await page.locator('#ia-i-reverter').click();
      expect(await foco()).toBe('ia-i-rev-ok');
      await textoContem(page.locator('.ia-confirma'), 'Voltar para +e1');
      await page.locator('#ia-i-rev-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
      await textoContem(page.locator('#ia-live'), 'Instrução revertida.');
      // sem alteração do operador, o editor SEGUE o servidor: mostra o texto que acabou de voltar a valer
      expect(await page.locator('#ia-i-texto').inputValue()).toBe(INSTRUCAO_UM);
      await page.locator('#ia-i-reverter').click();
      await textoContem(
        page.locator('.ia-confirma'),
        'Voltar para +e0 (o prompt padrão)',
      );
      await page.locator('#ia-i-rev-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e0');
      expect(await page.locator('#ia-i-reverter').isDisabled()).toBe(true);
      // o registro de mudanças da Fase A mostra tudo, e a próxima análise de qualquer usuário volta ao padrão
      await textoContem(page.locator('.ia-historico'), 'Instruções revertidas');
      await textoContem(page.locator('.ia-historico'), 'Instruções publicadas');
      await app.assinaturas.liberar({ workspace: WS, plano: 'ia', meses: 1 });
      const a = await servidor.inject({
        method: 'POST',
        url: `/v1/acompanhamentos/${DIGITOS}/analise`,
        headers: { 'x-api-key': CHAVE },
        payload: { chaveDoAto: CHAVE_DO_ATO },
      });
      expect(a.json().versaoPrompt).toBe('ato-1.2.0');
    });

    it('resumo: experimenta o processo inteiro (sem escolher ato) e mostra Situação e O que pede providência', async () => {
      await abrir();
      await page.locator('#ia-i-aba-resumo').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: resumo-1.2.0+e0');
      await page.locator('#ia-i-texto').fill('Abra a situação pelo ato mais recente.');
      await page.locator('#ia-i-exp-bt').click();
      await page.locator('#ia-i-exp-proc').selectOption(DIGITOS);
      expect(await page.locator('#ia-i-exp-ato').count()).toBe(0);
      await page.locator('#ia-i-exp-rodar').click();
      await page.locator('#ia-i-lado').waitFor();
      await textoContem(page.locator('#ia-i-lado'), 'Situação');
      await textoContem(page.locator('#ia-i-lado'), 'O que pede providência');
      // o rascunho NÃO precisa ser salvo para experimentar: o lado dele aparece como "não salvo"
      await textoContem(page.locator('#ia-i-lado'), 'não salvo');
      expect(resumidor.chamadas).toBe(2);
    });

    it('peça: lista só as peças da guarda e desenha o resultado com "O que determina", pedidos e valores', async () => {
      await abrir();
      // O serviço de peça não existe neste servidor de teste; a tela é provada contra respostas combinadas.
      await page.route('**/admin/api/ia/instrucoes', async (rota) => {
        const resposta = await rota.fetch();
        const corpo = await resposta.json();
        corpo.funcoes[2].experimentoDisponivel = true;
        await rota.fulfill({ response: resposta, json: corpo });
      });
      await page.route('**/admin/api/ia/experimento/processos/*/pecas', (rota) =>
        rota.fulfill({
          json: {
            sigiloso: false,
            pecas: [
              {
                pecaId: 'p1',
                rotulo: 'Petição inicial',
                data: '2026-10-01T12:00:00.000Z',
                paginas: 2,
              },
            ],
          },
        }),
      );
      const braco = (rotulo: string, versao: number) => ({
        rotulo,
        versao,
        versaoRotulo: `+e${versao}`,
        estado: 'ok',
        verificado: true,
        motivoDeNaoVerificacao: null,
        motivoDeNaoVerificacaoFrase: null,
        secoes: [
          {
            titulo: 'Em uma frase',
            itens: [
              {
                texto: 'Petição inicial que pede a restituição de valores.',
                nota: 'Tipo: peticao inicial',
              },
            ],
          },
          {
            titulo: 'Pedidos',
            itens: [
              {
                texto: 'Condenar a ré a restituir R$ 4.200,00',
                citacao: 'a condenacao da re a restituir R$ 4.200,00',
                nota: 'pág. 2',
              },
            ],
          },
          {
            titulo: 'O que determina',
            itens: [
              {
                texto: 'Estado: Determina que individualize a conta',
                citacao: 'individualize, no prazo de 10 (dez) dias',
                nota: 'pág. 1 · prazo escrito no ato: 10 (dez) dias',
              },
            ],
          },
        ],
        descartes: [
          { codigo: 'citacao', rotulo: 'citação que não está no texto', quantidade: 1 },
        ],
        citacoes: { emitidas: 4, validas: 3 },
        modelo: 'modelo/teste',
        latenciaMs: 3200,
        custoUsd: 0.002,
        tokensEntrada: 4000,
        tokensSaida: 400,
      });
      await page.route('**/admin/api/ia/instrucoes/peca/experimentar', (rota) =>
        rota.fulfill({
          json: { funcao: 'peca', bracos: [braco('publicada', 0), braco('rascunho', 0)] },
        }),
      );
      await page.reload();
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.locator('#ia-i-texto').waitFor();
      await page.locator('#ia-i-aba-peca').click();
      await page.locator('#ia-i-exp-bt').click();
      await page.locator('#ia-i-exp-proc').selectOption(DIGITOS);
      await page.locator('#ia-i-exp-peca').waitFor();
      expect(await page.locator('#ia-i-exp-peca option').allInnerTexts()).toEqual([
        'Escolha uma peça',
        expect.stringContaining('Petição inicial'),
      ]);
      await page.locator('#ia-i-exp-peca').selectOption('p1');
      await page.locator('#ia-i-exp-rodar').click();
      await page.locator('#ia-i-lado').waitFor();
      const col = await page.locator('#ia-i-lado .ia-i-col').first().innerText();
      expect(col).toContain('Em uma frase');
      expect(col).toContain('Pedidos');
      expect(col).toContain('O que determina');
      expect(col).toContain('prazo escrito no ato: 10 (dez) dias');
      expect(col).toContain('1 × citação que não está no texto');
      expect(col).toContain('Citações do modelo que existem no texto: 3 de 4.');
      expect(col).toContain('3,2 s');
    });

    it('aviso de rascunho não salvo: ao trocar de aba pergunta antes, ao fechar o navegador avisa, e salvo não pergunta', async () => {
      await abrir();
      await page.locator('#ia-i-texto').fill('Alteração que ainda não foi salva.');
      // fechar ou recarregar: o navegador pede confirmação (beforeunload cancelado pela página)
      const impediu = await page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      expect(impediu).toBe(true);
      // trocar de aba: diálogo; "Cancelar" fica onde está, com o texto
      const dialogos: string[] = [];
      const recusar = (d: Dialog): void => {
        dialogos.push(d.message());
        void d.dismiss();
      };
      page.once('dialog', recusar);
      await page.getByRole('button', { name: 'Assinaturas' }).click();
      expect(dialogos[0]).toContain('rascunho de instrução que não foi salvo');
      expect(await page.locator('#ia-i-texto').inputValue()).toBe(
        'Alteração que ainda não foi salva.',
      );
      expect(await page.locator('#nav-ia').getAttribute('class')).toContain('ativo');
      // "OK": sai e descarta
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('button', { name: 'Assinaturas' }).click();
      await page.locator('#nav-assinaturas.ativo').waitFor();
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.locator('#ia-i-texto').waitFor();
      expect(await page.locator('#ia-i-texto').inputValue()).toBe('');
      // depois de salvar, sai sem perguntar e o texto volta quando a aba reabre
      await escreverESalvar('Texto salvo.');
      const impediu2 = await page.evaluate(() => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      expect(impediu2).toBe(false);
      let perguntou = false;
      page.on('dialog', (d) => {
        perguntou = true;
        void d.dismiss();
      });
      await page.getByRole('button', { name: 'Assinaturas' }).click();
      await page.locator('#nav-assinaturas.ativo').waitFor();
      expect(perguntou).toBe(false);
      await page.getByRole('button', { name: 'IA', exact: true }).click();
      await page.locator('#ia-i-texto').waitFor();
      expect(await page.locator('#ia-i-texto').inputValue()).toBe('Texto salvo.');
    });

    it('o rascunho de uma função sobrevive a trocar de aba de função e a redesenhos da tela IA', async () => {
      await abrir();
      await page.locator('#ia-i-texto').fill('Sem salvar, só no editor.');
      await page.locator('#ia-i-aba-resumo').click();
      expect(await page.locator('#ia-i-texto').inputValue()).toBe('');
      await textoContem(page.locator('#ia-i-aba-ato'), 'Alterações não salvas');
      await page.locator('#ia-i-aba-ato').click();
      expect(await page.locator('#ia-i-texto').inputValue()).toBe(
        'Sem salvar, só no editor.',
      );
      // salvar o teto de uma função (a tela inteira se redesenha) não apaga o que o operador digitou
      await page.locator('#ia-f-ato-teto').fill('12');
      await page
        .locator('[data-funcao="ato"]')
        .getByRole('button', { name: 'Salvar teto' })
        .click();
      await textoContem(page.locator('[data-funcao="ato"]'), 'Teto efetivo agora: 12');
      expect(await page.locator('#ia-i-texto').inputValue()).toBe(
        'Sem salvar, só no editor.',
      );
      await textoContem(page.locator('#ia-i-sujo'), 'Alterações não salvas');
    });

    it('texto acima do limite: contador de aviso e salvar desabilitado', async () => {
      await abrir();
      await page.locator('#ia-i-texto').fill('a'.repeat(4001));
      await textoContem(page.locator('#ia-i-contador'), 'acima do limite');
      expect(await page.locator('#ia-i-salvar').isDisabled()).toBe(true);
      await page.locator('#ia-i-texto').fill('a'.repeat(4000));
      expect(await page.locator('#ia-i-contador .ia-acima').count()).toBe(0);
      expect(await page.locator('#ia-i-salvar').isDisabled()).toBe(false);
    });

    it('publicar fica desabilitado enquanto há alteração não salva, com a razão; e reaparece o "usar como rascunho" do histórico', async () => {
      await abrir();
      await escreverESalvar(INSTRUCAO_UM);
      await esperar(async () =>
        expect(await page.locator('#ia-i-publicar').isDisabled()).toBe(false),
      );
      await page.locator('#ia-i-texto').fill(INSTRUCAO_UM + ' mais um pouco');
      await esperar(async () =>
        expect(await page.locator('#ia-i-publicar').isDisabled()).toBe(true),
      );
      await textoContem(
        page.locator('#ia-i-pub-ajuda'),
        'Salve o rascunho para poder publicar.',
      );
      await page.locator('#ia-i-salvar').click();
      await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
      await page.locator('#ia-i-publicar').click();
      await page.locator('#ia-i-pub-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
      // texto antigo da história volta para o editor, marcado como não salvo
      await page.locator('#ia-i-hist-bt').click();
      await page.locator('#ia-i-texto').fill('Outro texto.');
      await textoContem(page.locator('#ia-i-sujo'), 'Alterações não salvas');
      await page.locator('[data-ia-i-usar="1"]').click();
      // a resposta é assíncrona: o editor volta ao texto de +e1 (igual ao salvo, então "Tudo salvo")
      await esperar(async () =>
        expect(await page.locator('#ia-i-texto').inputValue()).toBe(
          INSTRUCAO_UM + ' mais um pouco',
        ),
      );
      await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
      await page.locator('[data-ia-i-ver-texto="1"]').click();
      expect(await page.locator('#ia-i-vt').innerText()).toContain('mais um pouco');
    });

    it('conjunto de verificação: estimar, confirmar, acompanhar, ler os avisos (que não bloqueiam) e publicar mesmo assim', async () => {
      executor.chamadasFeitas = 5;
      let soltar!: () => void;
      executor.portao = new Promise<void>((r) => (soltar = r));
      executor.resultado = {
        tipo: 'ok',
        candidato: metricas({
          modelo: ATUAL,
          violacoes: 2,
          citacaoVerificada: 0.9,
          latenciaP95Ms: 11_000,
        }),
        referencia: metricas({ modelo: ATUAL }),
        gastoUsd: 0.07,
        tetoAtingido: false,
      };
      await abrir();
      await escreverESalvar(INSTRUCAO_UM);
      await page.locator('#ia-i-ver-bt').click();
      await page.locator('#ia-i-ver-estimar').click();
      await textoContem(page.locator('#ia-i-ver'), 'Chamadas ao provedor: 40');
      await textoContem(page.locator('#ia-i-ver'), 'Custo estimado: US$ 0,1000');
      await textoContem(page.locator('#ia-i-ver'), 'teto da rodada: US$ 1,00');
      await textoContem(page.locator('#ia-i-ver'), 'nada aqui impede de publicar');
      expect(executor.execucoes).toBe(0); // a estimativa vem ANTES de qualquer chamada
      await page.locator('#ia-i-ver-iniciar').click();
      await textoContem(page.locator('#ia-i-ver'), '5 de 40 chamadas');
      expect(
        await page.locator('[role="progressbar"]').getAttribute('aria-valuenow'),
      ).toBe('5');
      soltar();
      await textoContem(page.locator('#ia-i-ver'), 'Avisos de piora do rascunho');
      const t = await page.locator('#ia-i-ver').innerText();
      expect(t).toContain('informam, não bloqueiam a publicação');
      expect(t).toContain('mais violações');
      expect(t).toContain('abaixo de 95%');
      expect(t).toContain('Citação verificada');
      expect(t).toContain('Tempo de resposta p95');
      // publicar segue liberado, apesar dos avisos graves
      expect(await page.locator('#ia-i-publicar').isDisabled()).toBe(false);
      await page.locator('#ia-i-publicar').click();
      await page.locator('#ia-i-pub-ok').click();
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
    });

    it('conjunto de verificação sem piora: diz que ficou igual ou melhor; e sem executor diz que não está disponível', async () => {
      await abrir();
      await escreverESalvar(INSTRUCAO_UM);
      await page.locator('#ia-i-ver-bt').click();
      await page.locator('#ia-i-ver-estimar').click();
      await page.locator('#ia-i-ver-iniciar').click();
      await textoContem(page.locator('#ia-i-ver'), 'Nenhuma piora');
      await ctx.close();
      await servidor.close();
      await subir();
      await servidor.close();
      // sem executor
      analisador = new AnalisadorFalso();
      app = aplicacaoDeTeste(
        [new ProviderFalso({ nome: 'falso', porNumero: async () => umProcesso() })],
        {
          agora: () => AGORA,
          admin: { usuario: ADMIN_USUARIO, senha: ADMIN_SENHA },
          analiseIa: { analisador },
          modelosDeIa: {
            catalogo: catalogoDeTeste(),
            doAmbiente: { ato: ATUAL, resumo: ATUAL, peca: ATUAL },
          },
          instrucoesDeIa: { contaDoDono: async () => WS },
        },
      );
      servidor = construirServidor(
        app,
        carregarConfig({
          PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
          LOG_LEVEL: 'silent',
          CACHE_ENABLED: 'false',
          PROCESSOVIVO_API_KEYS: CHAVE,
          RATE_LIMIT_MAX: '100000',
        } as NodeJS.ProcessEnv),
      );
      await servidor.listen({ host: '127.0.0.1', port: 0 });
      const addr = servidor.server.address();
      url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      await abrir();
      await page.locator('#ia-i-ver-bt').click();
      await textoContem(page.locator('#ia-i-ver'), 'não está disponível neste servidor');
      expect(await page.locator('#ia-i-ver-estimar').count()).toBe(0);
    });

    it('"onde a IA erra": polegares por versão das instruções e os mais recentes para baixo, com o motivo', async () => {
      await app.assinaturas.liberar({ workspace: WS, plano: 'ia', meses: 1 });
      const analisar = async (): Promise<string> => {
        const r = await servidor.inject({
          method: 'POST',
          url: `/v1/acompanhamentos/${DIGITOS}/analise`,
          headers: { 'x-api-key': CHAVE },
          payload: { chaveDoAto: CHAVE_DO_ATO },
        });
        return r.json().id as string;
      };
      const avaliar = (id: string, corpo: object) =>
        servidor.inject({
          method: 'POST',
          url: `/v1/analises/${id}/avaliacao`,
          headers: { 'x-api-key': CHAVE },
          payload: corpo as Record<string, unknown>,
        });
      await avaliar(await analisar(), { avaliacao: 'util' });
      await avaliar(await analisar(), { avaliacao: 'errado', motivo: 'deixou_de_fora' });
      await abrir();
      await page.locator('#ia-i-erros-bt').click();
      await textoContem(
        page.locator('#ia-i-erros'),
        'Versão atual +e0: 2 análises · 1 polegar para cima · 1 para baixo de 2 avaliadas',
      );
      const t = await page.locator('#ia-i-erros').innerText();
      expect(t).toContain('motivo: deixou de fora algo importante');
      expect(t).toContain('ato-1.2.0+e0');
      expect(t).toContain(WS.slice(0, 8));
      expect(t).not.toContain(WS);
      expect(t).not.toContain('Mariana');
      expect(t).toContain('nunca o conteúdo da análise');
    });

    it('sem a conta do dono: o experimento explica o que falta, em vez de uma lista vazia', async () => {
      await ctx?.close();
      await servidor.close();
      await subir(false);
      await abrir();
      await page.locator('#ia-i-exp-bt').click();
      await textoContem(
        page.locator('#ia-i-exp'),
        'Não achei a sua conta para buscar os casos',
      );
      await textoContem(page.locator('#ia-i-exp'), 'PROCESSOVIVO_ADMIN_EMAIL');
    });

    it('só pelo teclado: abas com setas, escrever, salvar, publicar, e Esc/Cancelar devolvem o foco ao gatilho', async () => {
      await abrir();
      await page.locator('#ia-i-aba-ato').focus();
      await page.keyboard.press('ArrowRight');
      expect(await foco()).toBe('ia-i-aba-resumo');
      expect(await page.locator('#ia-i-aba-resumo').getAttribute('aria-selected')).toBe(
        'true',
      );
      await page.keyboard.press('End');
      expect(await foco()).toBe('ia-i-aba-peca');
      await page.keyboard.press('Home');
      expect(await foco()).toBe('ia-i-aba-ato');
      await page.locator('#ia-i-texto').focus();
      await page.keyboard.type('Instrução escrita só com o teclado.');
      await page.locator('#ia-i-salvar').focus();
      await page.keyboard.press('Enter');
      await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
      // o botão de salvar fica desabilitado (nada a salvar): o foco volta ao editor, onde a pessoa continua
      expect(await foco()).toBe('ia-i-texto');
      await page.locator('#ia-i-publicar').focus();
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-i-pub-ok');
      await page.keyboard.press('Tab');
      expect(await foco()).toBe('ia-i-pub-cancelar');
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-i-publicar');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
      // reverter, cancelar → foco volta ao gatilho
      await page.locator('#ia-i-reverter').focus();
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-i-rev-ok');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      expect(await foco()).toBe('ia-i-reverter');
    });

    it('regressão: os cartões da Fase A e a parte "Modelo" da Fase B continuam na tela, ao lado da nova seção', async () => {
      await abrir();
      await page.locator('[data-funcao="ato"] .ia-mod').waitFor();
      await textoContem(
        page.locator('[data-funcao="ato"]'),
        'Modelo em uso: Apelido modelo-atual',
      );
      expect(await page.locator('[data-funcao]').count()).toBe(3);
      await textoContem(page.locator('main'), 'Limites e alerta de custo');
      await textoContem(page.locator('main'), 'Últimas 50 mudanças');
      // a nova seção fica depois dos cartões e antes dos limites
      const ordem = await page.evaluate(() => {
        const q = (s: string): number =>
          (document.querySelector(s)?.getBoundingClientRect().top ?? -1) + window.scrollY;
        return [q('.ia-grade'), q('[data-ia-instrucoes]'), q('#ia-lim-t')];
      });
      expect(ordem[0]).toBeLessThan(ordem[1] as number);
      expect(ordem[1]).toBeLessThan(ordem[2] as number);
    });

    for (const escuro of [false, true]) {
      it(`axe sem violações (tema ${escuro ? 'escuro' : 'claro'}): editor, prévia, experimento, verificação, histórico com diff e erros`, async () => {
        executor.resultado = {
          tipo: 'ok',
          candidato: metricas({ modelo: ATUAL, violacoes: 1 }),
          referencia: metricas({ modelo: ATUAL }),
          gastoUsd: 0.07,
          tetoAtingido: false,
        };
        await abrir({ escuro });
        await page.addScriptTag({
          content: (AxeBuilder as unknown as { source: string }).source,
        });
        const rodar = async (): Promise<string> => {
          const r = await page.evaluate(() =>
            (window as unknown as AxeNaPagina).axe.run(
              { include: [['#conteudo']] } as unknown as Element,
              { rules: { 'color-contrast': { enabled: true } } },
            ),
          );
          return r.violations
            .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
            .join('\n');
        };
        expect(await rodar(), 'inicial').toBe('');
        await page.locator('#ia-i-texto').fill(INSTRUCAO_UM);
        expect(await rodar(), 'com alteração não salva').toBe('');
        await page.locator('#ia-i-salvar').click();
        await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
        await page.locator('#ia-i-previa-bt').click();
        await page.locator('#ia-i-p-exem').waitFor();
        expect(await rodar(), 'prévia').toBe('');
        await page.locator('#ia-i-previa-fechar').click();
        await page.locator('#ia-i-exp-bt').click();
        await page.locator('#ia-i-exp-proc').selectOption(DIGITOS);
        await page.locator('#ia-i-exp-ato').selectOption(CHAVE_DO_ATO);
        expect(await rodar(), 'escolha do caso').toBe('');
        await page.locator('#ia-i-exp-rodar').click();
        await page.locator('#ia-i-lado').waitFor();
        expect(await rodar(), 'experimento lado a lado').toBe('');
        await page.locator('#ia-i-exp-fechar').click();
        await page.locator('#ia-i-ver-bt').click();
        await page.locator('#ia-i-ver-estimar').click();
        expect(await rodar(), 'estimativa da verificação').toBe('');
        await page.locator('#ia-i-ver-iniciar').click();
        await textoContem(page.locator('#ia-i-ver'), 'Avisos de piora');
        expect(await rodar(), 'resultado da verificação').toBe('');
        await page.locator('#ia-i-ver-fechar').click();
        await page.locator('#ia-i-publicar').click();
        expect(await rodar(), 'confirmação de publicar').toBe('');
        await page.locator('#ia-i-pub-ok').click();
        await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
        await page.locator('#ia-i-hist-bt').click();
        await page.locator('#ia-i-diff-ir').click();
        await page.locator('#ia-i-diff').waitFor();
        expect(await rodar(), 'histórico com diff').toBe('');
        await page.locator('#ia-i-erros-bt').click();
        await textoContem(page.locator('#ia-i-erros'), 'Versão atual');
        expect(await rodar(), 'onde a IA erra').toBe('');
        await page.locator('#ia-i-reverter').click();
        expect(await rodar(), 'confirmação de reverter').toBe('');
      });
    }

    for (const largura of LARGURAS) {
      it(`${largura}px: sem rolagem horizontal com editor, prévia, experimento, verificação, histórico e erros abertos`, async () => {
        await abrir({ largura });
        const medir = async (etapa: string): Promise<void> => {
          const m = await page.evaluate(() => ({
            doc: document.documentElement.scrollWidth,
            janela: window.innerWidth,
            estourou: Array.from(
              document.querySelectorAll(
                '.ia-i-cartao, .ia-i-editor, textarea, .ia-i-painel, .ia-i-sec, .ia-i-col, .ia-i-pre, .ia-i-diff, .ia-m-tabela, .ia-i-abas',
              ),
            ).some((e) => e.getBoundingClientRect().right > window.innerWidth + 1),
          }));
          expect(m.doc, etapa).toBeLessThanOrEqual(m.janela);
          expect(m.estourou, `${etapa} (algum bloco passou da janela)`).toBe(false);
        };
        await medir('inicial');
        await page.locator('#ia-i-texto').fill(INSTRUCAO_UM + '\n' + 'x'.repeat(300));
        await page.locator('#ia-i-salvar').click();
        await textoContem(page.locator('#ia-i-sujo'), 'Tudo salvo');
        await page.locator('#ia-i-previa-bt').click();
        await page.locator('#ia-i-p-exem').waitFor();
        await medir('prévia');
        await page.locator('#ia-i-exp-bt').click();
        await page.locator('#ia-i-exp-proc').selectOption(DIGITOS);
        await page.locator('#ia-i-exp-ato').selectOption(CHAVE_DO_ATO);
        await page.locator('#ia-i-exp-rodar').click();
        await page.locator('#ia-i-lado').waitFor();
        await medir('experimento lado a lado');
        await page.locator('#ia-i-ver-bt').click();
        await page.locator('#ia-i-ver-estimar').click();
        await page.locator('#ia-i-ver-iniciar').click();
        await textoContem(page.locator('#ia-i-ver'), 'Última verificação');
        await esperar(async () =>
          expect(await page.locator('#ia-i-ver').innerText()).toContain('Concluído'),
        );
        await medir('verificação');
        await page.locator('#ia-i-publicar').click();
        await page.locator('#ia-i-pub-ok').click();
        await textoContem(page.locator('#ia-i-versao'), 'Em uso: ato-1.2.0+e1');
        await page.locator('#ia-i-hist-bt').click();
        await page.locator('#ia-i-diff-ir').click();
        await page.locator('#ia-i-erros-bt').click();
        await medir('histórico e erros');
        // a tela de IA inteira (cartões e seção) continua sem estourar
        const tudo = await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        );
        expect(tudo).toBe(true);
        // nada fica cortado: o botão de publicar e o de reverter cabem na janela
        for (const id of ['ia-i-publicar', 'ia-i-reverter', 'ia-i-salvar']) {
          // a tela se refaz depois de publicar (recarrega o registro da Fase A), e pode se refazer
          // entre a espera e a medida (o botão medido some e volta): mede de novo até achar
          await esperar(async () => {
            const r = await page.locator(`#${id}`).boundingBox();
            expect(r, id).not.toBeNull();
            expect((r?.x ?? 0) + (r?.width ?? 0), id).toBeLessThanOrEqual(largura + 1);
          });
        }
      });
    }
  },
);
