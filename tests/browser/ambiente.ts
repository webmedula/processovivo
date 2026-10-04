import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { NumeroCNJ } from '../../src/domain/entities/NumeroCNJ.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Aplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso, umProcesso } from '../helpers/fabricas.js';
import {
  HTML_SINTETICO,
  PROCESSO_TJGO,
  ProvedorDeLoteFalso,
  pastaTemporaria,
  pdfSintetico,
} from '../helpers/leitor.js';
import type { PecaFalsa } from '../helpers/leitor.js';

/** Descrição longa de ato: passa de 2 linhas em qualquer largura da lista. */
export const TEXTO_LONGO =
  'Juntada de manifestação extensa com a descrição repetida muitas vezes para passar ' +
  'de duas linhas: documento documento documento documento documento documento ' +
  'documento documento documento documento documento documento FIM-DO-TEXTO-LONGO';

export const CHAVE = 'chave-do-teste-de-navegador-1234567890';

/** O Chromium instalado no ambiente (Playwright não baixa nada aqui). */
export const CHROMIUM = [
  process.env['PV_CHROMIUM'] ?? '',
  '/opt/pw-browsers/chromium',
].find((c) => c && existsSync(c));

/**
 * Peças SINTÉTICAS (o repositório é público): nenhum nome, número ou texto
 * real. Rótulos genéricos, com o padrão "Tipo - complemento" do tribunal para
 * exercitar os atalhos por tipo.
 */
/**
 * Identificador interno do tribunal (como 516017862 num processo real). Longo de
 * propósito: se a tela voltar a mostrá-lo como "mov.", o teste vê o dígito.
 */
export const BASE_ID_INTERNO = 516017860;

export async function pecasDoTeste(): Promise<PecaFalsa[]> {
  const html = new TextEncoder().encode(HTML_SINTETICO);
  const pecas: PecaFalsa[] = [
    {
      id: 'p01',
      rotulo: 'Petição - inicial',
      bytes: await pdfSintetico(2, 'P01'),
      movimento: 1,
    },
    {
      id: 'p02',
      rotulo: 'Procuração',
      bytes: await pdfSintetico(1, 'P02'),
      movimento: 1,
    },
    {
      id: 'p03',
      rotulo: 'Documento - identificação',
      bytes: await pdfSintetico(1, 'P03'),
      movimento: 1,
    },
    {
      id: 'p04',
      rotulo: 'Despacho - inicial',
      mimetype: 'text/html',
      bytes: html,
      movimento: 2,
    },
    {
      id: 'p05',
      rotulo: 'Petição - contestação',
      bytes: await pdfSintetico(3, 'P05'),
      movimento: 3,
    },
    {
      id: 'p06',
      rotulo: 'Petição - réplica',
      bytes: await pdfSintetico(1, 'P06'),
      movimento: 4,
    },
    {
      id: 'p07',
      rotulo: 'Laudo pericial',
      bytes: await pdfSintetico(2, 'P07'),
      movimento: 5,
    },
    { id: 'p08', rotulo: 'Decisão', mimetype: 'text/html', bytes: html, movimento: 6 },
    { id: 'p09', rotulo: 'Sentença', bytes: await pdfSintetico(2, 'P09'), movimento: 7 },
    { id: 'p10', rotulo: 'Certidão sem teor', movimento: 8 },
    {
      id: 'p11',
      rotulo: 'Laudo sigiloso',
      bytes: await pdfSintetico(1, 'P11'),
      nivelSigilo: 1,
      movimento: 9,
    },
    { id: 'p12', rotulo: 'Recurso', bytes: await pdfSintetico(1, 'P12'), movimento: 10 },
  ];
  return pecas.map((p) =>
    p.movimento !== undefined ? { ...p, movimento: BASE_ID_INTERNO + p.movimento } : p,
  );
}

export interface Ambiente {
  readonly url: string;
  readonly app: Aplicacao;
  readonly provedor: ProvedorDeLoteFalso;
  readonly servidor: FastifyInstance;
  encerrar(): Promise<void>;
}

/**
 * O servidor de verdade (API + console + PDF.js) com um tribunal falso. O
 * debounce do servidor é real (400 ms); a pausa de 3 s do leitor é instantânea
 * — o que se mede aqui é a tela e o NÚMERO de lotes que o tribunal recebe.
 */
export async function iniciar(): Promise<Ambiente> {
  const pasta = pastaTemporaria();
  const provedor = new ProvedorDeLoteFalso(await pecasDoTeste());
  // Os atos do tribunal, SINTÉTICOS. Identificadores internos longos de
  // propósito (nunca podem aparecer na tela como número de movimentação) e "ev. 382" no texto, que é texto e não referência.
  // Os atos 8, 9 e 10 não existem: p10, p11 e p12 apontam para atos que o
  // tribunal não listou, e a linha fica sem bloco.
  const ato = (numero: number, titulo: string, complementos?: string[]) => ({
    data: new Date(Date.UTC(2026, 8, numero + 10, 13, 0, 0)),
    titulo,
    idExterno: `mni:${BASE_ID_INTERNO + numero}`,
    fonte: 'mni',
    ...(complementos ? { complementos } : {}),
  });
  provedor.movimentos = [
    ato(1, 'Juntada de documentos iniciais'),
    ato(2, 'Conclusos para despacho', ['prioridade: normal']),
    ato(3, TEXTO_LONGO),
    ato(4, 'Juntada de manifestação sobre o ev. 382 (movimentação nº 5000)'),
    ato(5, 'Juntada de documento técnico'),
    ato(6, 'Conclusos para decisão'),
    ato(7, 'Publicado ato do juízo'),
    // Fora de ordem de propósito: a posição vem da ordem cronológica, não da
    // ordem em que o tribunal respondeu.
  ].reverse();
  const processo = umProcesso({
    numero: NumeroCNJ.criar(PROCESSO_TJGO),
    tribunal: 'TJGO',
  });
  const app = aplicacaoDeTeste(
    [new ProviderFalso({ nome: 'falso', porNumero: async () => processo })],
    {
      provedorDePecas: provedor,
      leitor: { pasta: pasta.caminho, executarSozinho: true },
      pasta: { debounceMs: 400 },
    },
  );
  const servidor = construirServidor(
    app,
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      LOG_LEVEL: 'silent',
      CACHE_ENABLED: 'false',
      PROCESSOVIVO_API_KEYS: CHAVE,
    } as NodeJS.ProcessEnv),
  );
  const headers = { 'x-api-key': CHAVE };
  await servidor.inject({
    method: 'PUT',
    url: '/v1/credenciais',
    headers,
    payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'senha-sintetica' },
  });
  const acomp = await servidor.inject({
    method: 'POST',
    url: '/v1/acompanhamentos',
    headers,
    payload: { numero: PROCESSO_TJGO },
  });
  if (acomp.statusCode >= 300)
    throw new Error(`acompanhar: ${acomp.statusCode} ${acomp.body}`);
  await servidor.listen({ host: '127.0.0.1', port: 0 });
  const addr = servidor.server.address();
  const porta = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${porta}`,
    app,
    provedor,
    servidor,
    encerrar: async () => {
      await servidor.close();
      pasta.apagar();
    },
  };
}
