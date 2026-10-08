import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DjenAdapter } from '../../src/infrastructure/adapters/djen/DjenAdapter.js';
import {
  agruparEmProcessos,
  mapearMovimentacao,
  mapearPolo,
  ehTeorNaoPublico,
  parseDataDisponibilizacao,
  estaVigente,
} from '../../src/infrastructure/adapters/djen/djen.mapper.js';
import {
  decodificarEntidades,
  limparTextoDoAto,
} from '../../src/infrastructure/adapters/djen/textoHtml.js';
import { respostaDjenSchema } from '../../src/infrastructure/adapters/djen/djen.types.js';
import type { ComunicacaoDjen } from '../../src/infrastructure/adapters/djen/djen.types.js';
import { HttpClient } from '../../src/infrastructure/http/HttpClient.js';
import type { RespostaHttp } from '../../src/infrastructure/http/HttpClient.js';
import type { RateLimiter } from '../../src/infrastructure/ratelimit/TokenBucketRateLimiter.js';
import { RespostaInvalidaError } from '../../src/domain/errors/index.js';

/**
 * Estes testes rodam contra a resposta que o DJEN devolveu DE VERDADE em
 * 05/09/2026, não contra um payload que eu escrevi.
 *
 * O motivo está no CLAUDE.md e foi caro: no adapter do DataJud, 161 testes
 * verdes não pegaram que `dataAjuizamento` vinha em `yyyyMMddHHmmss`, porque eu
 * tinha inventado o fixture, o parser e a asserção — um circuito fechado que
 * nunca tocava a realidade. Ao capturar payload novo, salve e NÃO edite os
 * valores.
 */
const BRUTO: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/djen-comunica-real.json', import.meta.url), 'utf8'),
);

const PAYLOAD = respostaDjenSchema.parse(BRUTO);
const COMUNICACAO = PAYLOAD.items[0] as ComunicacaoDjen;
const AGORA = new Date('2026-09-05T12:00:00Z');

const limitadorPermissivo: RateLimiter = {
  adquirir: async () => {},
  tentarAdquirir: () => true,
};

class HttpFalso extends HttpClient {
  readonly urls: string[] = [];
  constructor(private readonly responder: (url: string) => RespostaHttp) {
    super();
  }
  override async get(url: string): Promise<RespostaHttp> {
    this.urls.push(url);
    return this.responder(url);
  }
}

function adapter(responder: (url: string) => RespostaHttp): {
  djen: DjenAdapter;
  http: HttpFalso;
} {
  const http = new HttpFalso(responder);
  return {
    http,
    djen: new DjenAdapter({
      httpClient: http,
      rateLimiter: limitadorPermissivo,
      clock: { agora: () => AGORA, monotonico: () => 0 },
    }),
  };
}

describe('payload real do DJEN', () => {
  it('o schema aceita a resposta que o CNJ devolveu', () => {
    // Se este teste quebrar, a API mudou — não conserte o fixture, capture de novo.
    expect(PAYLOAD.status).toBe('success');
    expect(PAYLOAD.count).toBe(1871);
    expect(PAYLOAD.items).toHaveLength(1);
  });

  it('extrai o advogado com OAB e UF — o dado que o DataJud não tem', () => {
    // É a razão inteira de o DJEN existir no projeto.
    const advogado = COMUNICACAO.destinatarioadvogados?.[0]?.advogado;
    expect(advogado?.nome).toBe('GUILHERME FREITAS DE OLIVEIRA');
    expect(advogado?.numero_oab).toBe('47383');
    expect(advogado?.uf_oab).toBe('GO');
  });

  it('decodifica as entidades HTML do inteiro teor', () => {
    // O texto real vem escapado: "PODER JUDICI&Aacute;RIO". Servir isso na tela
    // mostraria o despacho cheio de lixo.
    const mov = mapearMovimentacao(COMUNICACAO);
    expect(mov.conteudo).toContain('PODER JUDICIÁRIO');
    expect(mov.conteudo).toContain('Tribunal de Justiça do Estado de Goiás');
    expect(mov.conteudo).toContain('ATO ORDINATÓRIO');
    expect(mov.conteudo).not.toMatch(/&[a-z]+;/i);
  });

  it('não trunca o inteiro teor', () => {
    // Meio despacho faz o advogado concluir o oposto do que ele diz.
    const mov = mapearMovimentacao(COMUNICACAO);
    expect(mov.conteudo).toContain('INTIMEM-SE as partes');
  });

  it('a data de disponibilização não anda um dia para trás', () => {
    // O bug que este projeto já pagou uma vez: new Date('2026-09-04') é
    // meia-noite UTC, que em Brasília é 03/09 às 21h. A asserção é sobre o dia
    // EXIBIDO, não sobre o timestamp.
    const mov = mapearMovimentacao(COMUNICACAO);
    const exibida = mov.data.toLocaleDateString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });
    expect(exibida).toBe('04/09/2026');
  });

  it('guarda o TIPO da comunicação (e só ele), sem mais texto — v0.37.5', () => {
    const mov = mapearMovimentacao(COMUNICACAO);
    // A captura real: documento "Ato ordinatório" endereçado como Intimação.
    expect(mov.titulo).toBe('Ato ordinatório');
    expect(mov.tipoComunicacao).toBe('Intimação');
    // A data é a de disponibilização e o identificador da comunicação já está em idExterno.
    expect(mov.idExterno).toBe(`djen:${COMUNICACAO.id}`);
  });

  it('a intimação da captura real passa a EXIGIR ação, e o processo montado a marca', () => {
    const { processos } = agruparEmProcessos([COMUNICACAO], AGORA);
    expect(processos[0]?.movimentacoes[0]?.exigeAcao).toBe(true);
  });

  it('comunicação sem tipo não ganha campo (nada de undefined gravado)', () => {
    const mov = mapearMovimentacao({ ...COMUNICACAO, tipoComunicacao: null });
    expect('tipoComunicacao' in mov).toBe(false);
  });

  it('recusa data em formato desconhecido em vez de virar Invalid Date', () => {
    expect(() => parseDataDisponibilizacao('04/09/2026x', 'teste')).toThrow(
      RespostaInvalidaError,
    );
  });

  it('monta o Processo com número, tribunal, vara e classe', () => {
    const { processos } = agruparEmProcessos([COMUNICACAO], AGORA);
    const p = processos[0];

    expect(p?.numero.formatado).toBe('5578470-05.2026.8.09.0085');
    expect(p?.tribunal).toBe('TJGO');
    expect(p?.vara).toBe('Itapuranga - 1ª Vara Cível');
    expect(p?.classe).toBe('PROCEDIMENTO COMUM CíVEL');
    expect(p?.procedencia.provider).toBe('djen');
  });

  it('liga a parte ao advogado dela', () => {
    const { processos } = agruparEmProcessos([COMUNICACAO], AGORA);
    const parte = processos[0]?.partes[0];

    expect(parte?.nome).toBe('MARIA DE FATIMA LEITE');
    expect(parte?.polo).toBe('ATIVO');
    expect(parte?.advogados[0]?.oab).toBe('47383');
    expect(parte?.advogados[0]?.ufOab).toBe('GO');
  });

  it('não inventa pessoa física ou jurídica', () => {
    // O DJEN não informa, e adivinhar por sufixo erra com espólio e condomínio.
    const { processos } = agruparEmProcessos([COMUNICACAO], AGORA);
    expect(processos[0]?.partes[0]?.tipoPessoa).toBe('DESCONHECIDO');
  });

  it('buscarPorNumero consulta a API com o número MASCARADO', () => {
    // Verificado contra a API real: os 20 dígitos crus não retornam nada.
    const { djen, http } = adapter(() => ({
      status: 200,
      ok: true,
      corpo: JSON.stringify(PAYLOAD),
    }));

    return djen.buscarPorNumero('5578470-05.2026.8.09.0085').then((p) => {
      expect(p.tribunal).toBe('TJGO');
      expect(http.urls[0]).toContain('numeroProcesso=5578470-05.2026.8.09.0085');
    });
  });

  it('buscarPorOab manda numeroOab e ufOab e para na página incompleta', async () => {
    const { djen, http } = adapter(() => ({
      status: 200,
      ok: true,
      corpo: JSON.stringify(PAYLOAD),
    }));

    const processos = await djen.buscarPorOab('47383', 'GO');

    expect(processos).toHaveLength(1);
    expect(http.urls[0]).toContain('numeroOab=47383');
    expect(http.urls[0]).toContain('ufOab=GO');
    // Uma página com 1 item (< 100) significa fim do conjunto: não pede a próxima.
    expect(http.urls).toHaveLength(1);
  });
});

describe('limpeza do inteiro teor', () => {
  /**
   * Entidades observadas numa amostra REAL de 25 comunicações do DJEN
   * (busca por OAB 47383/GO em 05/09/2026). Se o CNJ passar a emitir uma nova,
   * este teste é o lugar de registrá-la.
   */
  const ENTIDADES_REAIS = [
    'Aacute', 'ccedil', 'aacute', 'ordf', 'iacute', 'nbsp', 'Oacute', 'ordm',
    'sect', 'oacute', 'otilde', 'atilde', 'Ccedil', 'Acirc', 'Iacute', 'gt',
    'Atilde', 'acirc', 'uacute', 'Ecirc', 'amp', 'agrave', 'ndash', 'eacute',
    'Eacute', 'Uacute',
  ];

  it('resolve todas as entidades que o DJEN emite de fato', () => {
    const naoResolvidas = ENTIDADES_REAIS.filter(
      (e) => decodificarEntidades(`&${e};`) === `&${e};`,
    );
    expect(naoResolvidas).toEqual([]);
  });

  it('não troca maiúscula por minúscula ao decodificar', () => {
    // `&Aacute;` e `&aacute;` são letras diferentes: normalizar transformaria
    // "JUDICIÁRIO" em "JUDICIáRIO".
    expect(decodificarEntidades('&Aacute;&aacute;')).toBe('Áá');
  });

  it('remove marcação de verdade — as notificações do TRT10 vêm com HTML', () => {
    const bruto =
      '<p>Fica <b>V. Sa.</b> notificada</p><br><table><tr><td>1&ordm; grau</td></tr></table>';
    expect(limparTextoDoAto(bruto)).toBe('Fica V. Sa. notificada\n\n1º grau');
  });

  it('preserva tag ESCRITA dentro do despacho', () => {
    // Este teste nasceu de um bug meu: eu decodificava antes de remover as tags,
    // então `&lt;prazo&gt;` virava `<prazo>` e o passo seguinte apagava — o ato
    // perdia um trecho em silêncio.
    expect(limparTextoDoAto('use a marca &lt;prazo&gt; aqui')).toBe(
      'use a marca <prazo> aqui',
    );
  });
});

describe('teor que a fonte não entrega', () => {
  // 43 das 62 publicações do processo 0311517-22.2015.8.09.0051 trazem só o
  // aviso de indisponibilidade. Guardá-lo como despacho faria a tela exibir 43
  // andamentos com um "inteiro teor" que só diz que não há inteiro teor.
  const SENTINELA = 'ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)';

  function comTexto(texto: string): ComunicacaoDjen {
    return { ...COMUNICACAO, id: 999, texto, tipoDocumento: 'Outros' };
  }

  it('reconhece o aviso de documento não público', () => {
    expect(ehTeorNaoPublico(SENTINELA)).toBe(true);
  });

  it('não grava o aviso como se fosse o despacho', () => {
    const m = mapearMovimentacao(comTexto(SENTINELA));
    expect(m.conteudo).toBeUndefined();
    expect(m.teorIndisponivel).toBe(true);
  });

  it('mantém o link para o tribunal, que é o caminho que sobra', () => {
    const m = mapearMovimentacao(comTexto(SENTINELA));
    expect(m.url).toContain('projudi.tjgo.jus.br');
  });

  it('teor curto de verdade continua sendo teor', () => {
    // O corte não pode ser por tamanho: "Ciência da decisão." é ato real.
    const m = mapearMovimentacao(comTexto('Ciência da decisão.'));
    expect(m.conteudo).toBe('Ciência da decisão.');
    expect(m.teorIndisponivel).toBeUndefined();
  });

  it('sem teor, o orquestrador volta a considerar que falta conteúdo', () => {
    // Efeito colateral desejado: um processo cujas publicações são todas
    // indisponíveis não parece "completo", e a cadeia continua perguntando às
    // outras fontes em vez de parar achando que já tem tudo.
    const { processos } = agruparEmProcessos([comTexto(SENTINELA)], AGORA);
    expect(processos[0]?.movimentacoes.some((m) => m.conteudo)).toBe(false);
  });
});

describe('agrupamento de comunicações em processos', () => {
  function comunicacao(campos: Partial<ComunicacaoDjen>): ComunicacaoDjen {
    return { ...COMUNICACAO, ...campos };
  }

  it('várias publicações do mesmo processo viram UM processo com vários andamentos', () => {
    // É a inversão central do DJEN: a fonte é de comunicações, a porta é de
    // processos.
    const { processos } = agruparEmProcessos(
      [
        comunicacao({ id: 1, data_disponibilizacao: '2026-09-04' }),
        comunicacao({ id: 2, data_disponibilizacao: '2026-09-01' }),
        comunicacao({ id: 3, data_disponibilizacao: '2026-08-20' }),
      ],
      AGORA,
    );

    expect(processos).toHaveLength(1);
    expect(processos[0]?.movimentacoes).toHaveLength(3);
  });

  it('duas publicações no MESMO dia continuam sendo dois andamentos', () => {
    // Sem `idExterno` elas colidiriam em data+título e a segunda decisão do dia
    // nunca viraria novidade para o advogado.
    const { processos } = agruparEmProcessos(
      [
        comunicacao({ id: 717509289, tipoDocumento: 'Decisão' }),
        comunicacao({ id: 717509300, tipoDocumento: 'Decisão' }),
      ],
      AGORA,
    );

    const chaves = new Set(processos[0]?.movimentacoes.map((m) => m.idExterno));
    expect(chaves.size).toBe(2);
  });

  it('descarta comunicação com número inválido sem derrubar as demais', () => {
    // Numa busca por OAB, 1 registro podre não pode esconder os outros 1.870.
    const { processos, descartadas } = agruparEmProcessos(
      [
        comunicacao({ id: 1 }),
        comunicacao({
          id: 2,
          numeroprocessocommascara: '0000000-00.0000.0.00.0000',
          numero_processo: '00000000000000000000',
        }),
      ],
      AGORA,
    );

    expect(processos).toHaveLength(1);
    expect(descartadas).toHaveLength(1);
  });

  it('ignora comunicação cancelada', () => {
    // Contar prazo a partir de ato sem efeito é perder prazo.
    const { processos } = agruparEmProcessos(
      [comunicacao({ id: 9, motivo_cancelamento: 'erro material' })],
      AGORA,
    );
    expect(processos).toHaveLength(0);
    expect(estaVigente(comunicacao({ ativo: false }))).toBe(false);
    expect(estaVigente(COMUNICACAO)).toBe(true);
  });

  it('usa a vara da publicação mais recente quando o processo muda de vara', () => {
    const { processos } = agruparEmProcessos(
      [
        comunicacao({ id: 1, data_disponibilizacao: '2026-01-10', nomeOrgao: 'Vara Antiga' }),
        comunicacao({ id: 2, data_disponibilizacao: '2026-09-04', nomeOrgao: 'Vara Atual' }),
      ],
      AGORA,
    );
    expect(processos[0]?.vara).toBe('Vara Atual');
  });

  it('não inverte os polos quando o rótulo é desconhecido', () => {
    // Trocar ativo por passivo inverte quem processa quem.
    expect(mapearPolo('A')).toBe('ATIVO');
    expect(mapearPolo('P')).toBe('PASSIVO');
    expect(mapearPolo('X')).toBe('OUTROS');
    expect(mapearPolo(null)).toBe('OUTROS');
  });
});
