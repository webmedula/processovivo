import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PdftotextExtrator } from '../../src/infrastructure/pdf/PdftotextExtrator.js';
import {
  USO_DA_SONDA_MNI_PJE,
  executarComandoSondaMniPje,
} from '../../src/main/sonda/comandoSondaMniPje.js';
import {
  OPERACOES_PERMITIDAS,
  linhasDoRelatorio,
  marcarMensagemDoTribunal,
  mascararMensagemDoTribunal,
  type RelatorioDaSonda,
} from '../../src/main/sonda/sondaMniPje.js';
import {
  CPF_SINTETICO,
  CPF_SO_DIGITOS,
  DIGITOS_SINTETICOS,
  HttpFalsoDoPje,
  ID_SENTINELA,
  NOME_SENTINELA,
  NUMERO_SINTETICO,
  SENHA_SINTETICA,
  TEXTO_SENTINELA,
  URL_SINTETICA,
  consultaPje,
  erroDeRede,
  erroDeTempo,
  recusaPje,
  texto,
} from '../helpers/pjeSintetico.js';
import { pdfComPaginas, pdfSoComImagem } from '../helpers/pdfDePecas.js';

/*
 * A sonda do MNI do PJe (v0.59.0): servidor falso e sintético, nenhuma rede, nenhum relógio real. O que se
 * prova aqui é o que importa para a conta do advogado: UMA tentativa, parada na primeira recusa, só consulta,
 * e NADA além de contagens e categorias na saída.
 */

const SENTINELAS = [
  NUMERO_SINTETICO,
  DIGITOS_SINTETICOS,
  CPF_SINTETICO,
  CPF_SO_DIGITOS,
  SENHA_SINTETICA,
  NOME_SENTINELA,
  'Sentinela',
  TEXTO_SENTINELA,
  ID_SENTINELA,
  'exemplo-sintetico',
  URL_SINTETICA,
];

interface Execucao {
  readonly codigo: number;
  readonly saida: string[];
  readonly aviso: string[];
  readonly http: HttpFalsoDoPje;
  readonly env: Record<string, string | undefined>;
  readonly tudo: string;
}

async function rodar(
  configurar: (h: HttpFalsoDoPje) => void,
  opcoes: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    perguntas?: Record<string, string | undefined>;
  } = {},
): Promise<Execucao> {
  const http = new HttpFalsoDoPje();
  configurar(http);
  const saida: string[] = [];
  const aviso: string[] = [];
  const env: Record<string, string | undefined> = opcoes.env ?? {
    SONDA_MNI_CPF: CPF_SINTETICO,
    SONDA_MNI_SENHA: SENHA_SINTETICA,
  };
  const codigo = await executarComandoSondaMniPje({
    argv: opcoes.argv ?? [`--url=${URL_SINTETICA}`, `--processo=${NUMERO_SINTETICO}`],
    env,
    perguntarSemEco: async (r) => opcoes.perguntas?.[r],
    saida: (l) => saida.push(l),
    aviso: (l) => aviso.push(l),
    criarHttp: () => http,
    criarExtrator: () => new PdftotextExtrator(),
  });
  return { codigo, saida, aviso, http, env, tudo: [...saida, ...aviso].join('\n') };
}

const umaLinhaCom = (e: Execucao, trecho: string): boolean =>
  e.saida.some((l) => l.includes(trecho));

describe('sonda do MNI do PJe — o caminho feliz', () => {
  it('conta movimentos, partes, tipos de arquivo, tamanhos e camada de texto; o veredito traz as ressalvas', async () => {
    const comTexto = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
    const semTexto = await pdfSoComImagem(2);
    const e = await rodar((h) => {
      h.respostasDePost = [
        consultaPje({ movimentos: 7, partes: 3 }, false),
        consultaPje({
          movimentos: 7,
          partes: 3,
          documentos: [
            { id: ID_SENTINELA, bytes: comTexto },
            { id: 'd2', bytes: semTexto },
            {
              id: 'd3',
              mimetype: 'text/html',
              bytes: new TextEncoder().encode('<p>x</p>'),
            },
            { id: 'd4' },
            { id: 'd5', bytes: comTexto, vinculados: [{ id: 'd6', bytes: comTexto }] },
          ],
        }),
      ];
    });
    expect(e.codigo).toBe(0);
    expect(
      umaLinhaCom(
        e,
        'categoria: ok · movimentos: 7 · partes: 3 · segredo de justiça: não',
      ),
    ).toBe(true);
    expect(
      umaLinhaCom(e, 'documentos: 6 · com conteúdo: 5 · só referência, sem conteúdo: 1'),
    ).toBe(true);
    expect(umaLinhaCom(e, 'por tipo de arquivo: pdf 4 · html 1 · outro 0')).toBe(true);
    expect(
      umaLinhaCom(
        e,
        'PDFs com camada de texto: 3 de 4 examinados (sem texto 1 · ilegíveis 0)',
      ),
    ).toBe(true);
    expect(
      e.saida.some((l) =>
        /tamanho \(KB\): mínimo [\d.]+ · mediano [\d.]+ · máximo [\d.]+/.test(l),
      ),
    ).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: viável com ressalvas')).toBe(true);
    expect(
      umaLinhaCom(e, 'ressalva: 1 documento(s) vieram só como referência, sem conteúdo'),
    ).toBe(true);
    expect(umaLinhaCom(e, 'ressalva: 1 PDF(s) sem texto pesquisável ou ilegíveis')).toBe(
      true,
    );
    expect(umaLinhaCom(e, 'ressalva: 1 documento(s) em HTML')).toBe(true);
    expect(umaLinhaCom(e, 'não testado por risco de ciência')).toBe(true);
    expect(e.http.posts).toHaveLength(2);
    expect(e.http.gets).toEqual([`${URL_SINTETICA}?wsdl`]);
  });

  it('só PDFs com texto e nenhuma pendência: "viável"', async () => {
    const pdf = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
    const e = await rodar((h) => {
      h.respostasDePost = [
        consultaPje({}, false),
        consultaPje({
          documentos: [
            { id: 'a', bytes: pdf },
            { id: 'b', bytes: pdf },
          ],
        }),
      ];
    });
    expect(e.codigo).toBe(0);
    expect(umaLinhaCom(e, 'VEREDITO: viável')).toBe(true);
    expect(e.saida.some((l) => l.includes('ressalva:'))).toBe(false);
  });

  it('segredo de justiça aparece como ressalva', async () => {
    const pdf = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
    const e = await rodar((h) => {
      h.respostasDePost = [
        consultaPje({ nivelSigilo: 5 }, false),
        consultaPje({ nivelSigilo: 5, documentos: [{ id: 'a', bytes: pdf }] }),
      ];
    });
    expect(umaLinhaCom(e, 'segredo de justiça: sim')).toBe(true);
    expect(
      umaLinhaCom(e, 'ressalva: o processo testado está em segredo de justiça'),
    ).toBe(true);
  });

  it('a descrição do serviço mostra se há consulta, avisos, teor e operação de escrita — sem chamar nenhuma', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [consultaPje({}, false), consultaPje({})];
    });
    const linha = e.saida.find((l) => l.includes('descrição do serviço lida: sim')) ?? '';
    expect(linha).toContain('oferece consultarProcesso: sim');
    expect(linha).toContain('tem operação de escrita: sim (a sonda não chama nenhuma)');
  });
});

describe('sonda do MNI do PJe — para na primeira recusa e nunca repete', () => {
  it('credencial recusada: UMA chamada, categoria "recusada", sem consulta com documentos, inviável', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [recusaPje('Usuário ou senha inválida.')];
    });
    expect(e.codigo).toBe(1);
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: recusada')).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
    expect(umaLinhaCom(e, 'motivo: o tribunal recusou a credencial')).toBe(true);
    expect(e.saida.some((l) => l.includes('categoria: nao_executada'))).toBe(true);
  });

  it.each([
    [
      'É necessário certificado digital ICP-Brasil para acessar o serviço',
      'exige_certificado',
    ],
    ['Informe o código de verificação enviado ao seu celular', 'exige_segundo_fator'],
    ['O advogado não possui perfil habilitado para o MNI', 'exige_cadastro_ou_perfil'],
  ])('"%s" → %s: para na hora, sem segunda chamada', async (mensagem, categoria) => {
    const e = await rodar((h) => {
      h.respostasDePost = [recusaPje(mensagem)];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, `categoria: ${categoria}`)).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
  });

  it('HTTP 403: categoria própria e uma chamada só', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [texto(403, 'proibido', 'text/html')];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: acesso_negado_http_403')).toBe(true);
  });

  it('HTTP 401: pede autenticação HTTP', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [texto(401, '<html>login</html>', 'text/html')];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: http_401')).toBe(true);
  });

  it('HTTP 404 no POST: o endereço do serviço está errado', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [texto(404, '<html>nada</html>', 'text/html')];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: url_nao_encontrada_http_404')).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
  });

  it('tempo esgotado: UMA tentativa (sem repetição) e categoria de tempo', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [erroDeTempo()];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: tempo_esgotado')).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
  });

  it('resposta malformada (HTML no lugar do envelope): categoria própria, uma chamada', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [
        texto(200, '<html><body>Bem-vindo</body></html>', 'text/html'),
      ];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: resposta_malformada')).toBe(true);
  });

  it('o tribunal aceita a credencial mas não entrega a linha do tempo: "sem habilitação nos autos"', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [consultaPje({ movimentos: 0, partes: 2 }, false)];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: aceita')).toBe(true);
    expect(umaLinhaCom(e, 'categoria: sem_habilitacao_nos_autos')).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
  });

  it('processo não encontrado: para (não tenta outro número)', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [recusaPje('Processo não encontrado')];
    });
    expect(e.http.posts).toHaveLength(1);
    expect(umaLinhaCom(e, 'categoria: processo_nao_encontrado')).toBe(true);
  });

  it('se a consulta com documentos falha depois de a sem documentos funcionar: viável com ressalvas, sem repetir', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [consultaPje({}, false), erroDeTempo()];
    });
    expect(e.http.posts).toHaveLength(2);
    expect(umaLinhaCom(e, 'VEREDITO: viável com ressalvas')).toBe(true);
    expect(umaLinhaCom(e, 'a consulta com documentos falhou')).toBe(true);
  });
});

describe('sonda do MNI do PJe — a conexão (antes de qualquer credencial)', () => {
  it.each([
    ['ENOTFOUND', 'dns_nao_resolve'],
    ['ECONNREFUSED', 'conexao_recusada'],
    ['ECONNRESET', 'conexao_reiniciada'],
    ['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'exige_certificado_de_cliente'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificado_do_servidor_nao_confiavel'],
    ['ALGUMA_COISA_ESTRANHA', 'erro_de_rede_outro'],
  ])('%s → %s, e nenhuma credencial é enviada', async (codigo, categoria) => {
    const e = await rodar((h) => {
      h.wsdl = erroDeRede(codigo);
      h.respostasDePost = [consultaPje({})];
    });
    expect(e.http.posts).toHaveLength(0);
    expect(umaLinhaCom(e, `categoria: ${categoria}`)).toBe(true);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
    expect(umaLinhaCom(e, 'categoria: nao_testada')).toBe(true);
  });

  it('tempo esgotado na descrição do serviço: nada é enviado', async () => {
    const e = await rodar((h) => {
      h.wsdl = erroDeTempo();
      h.respostasDePost = [consultaPje({})];
    });
    expect(e.http.posts).toHaveLength(0);
    expect(umaLinhaCom(e, 'categoria: tempo_esgotado')).toBe(true);
  });

  it('HTTP 404 na descrição: endereço errado, nada é enviado', async () => {
    const e = await rodar((h) => {
      h.wsdl = { status: 404, corpo: 'não existe' };
      h.respostasDePost = [consultaPje({})];
    });
    expect(e.http.posts).toHaveLength(0);
    expect(umaLinhaCom(e, 'categoria: url_nao_encontrada_http_404')).toBe(true);
  });

  it('o serviço que não oferece consultarProcesso é inviável sem enviar credencial', async () => {
    const e = await rodar((h) => {
      h.wsdl = {
        status: 200,
        corpo: '<definitions><operation name="outraCoisa"/></definitions>',
      };
      h.respostasDePost = [consultaPje({})];
    });
    expect(e.http.posts).toHaveLength(0);
    expect(umaLinhaCom(e, 'VEREDITO: inviável')).toBe(true);
  });

  it('WSDL ilegível (HTML) não impede a consulta: vira ressalva', async () => {
    const pdf = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
    const e = await rodar((h) => {
      h.wsdl = { status: 200, corpo: '<html>login</html>' };
      h.respostasDePost = [
        consultaPje({}, false),
        consultaPje({ documentos: [{ id: 'a', bytes: pdf }] }),
      ];
    });
    expect(e.http.posts).toHaveLength(2);
    expect(
      umaLinhaCom(e, 'ressalva: a descrição do serviço (WSDL) não pôde ser lida'),
    ).toBe(true);
  });

  it('um endereço que já termina em ?wsdl é normalizado: o POST vai ao serviço, o GET à descrição', async () => {
    const e = await rodar(
      (h) => {
        h.respostasDePost = [consultaPje({}, false), consultaPje({})];
      },
      {
        argv: [`--url=${URL_SINTETICA}?wsdl`, `--processo=${NUMERO_SINTETICA_PARA_ARGV}`],
      },
    );
    expect(e.http.gets).toEqual([`${URL_SINTETICA}?wsdl`]);
  });
});

const NUMERO_SINTETICA_PARA_ARGV = NUMERO_SINTETICO;

describe('sonda do MNI do PJe — só consulta, nunca escrita nem ciência', () => {
  it('a lista de operações permitidas tem UMA entrada; crescer exige mexer neste teste (e revisar)', () => {
    expect(OPERACOES_PERMITIDAS).toEqual(['consultarProcesso']);
  });

  it('todo POST é consultarProcesso: nenhum envelope de aviso, teor, manifestação ou ciência sai', async () => {
    const pdf = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
    const e = await rodar((h) => {
      h.respostasDePost = [
        consultaPje({}, false),
        consultaPje({ documentos: [{ id: 'a', bytes: pdf }] }),
      ];
    });
    expect(e.http.posts.length).toBeLessThanOrEqual(2);
    for (const p of e.http.posts) {
      expect(p.envelope).toContain('<srv:consultarProcesso>');
      expect(p.acao.endsWith('consultarProcesso')).toBe(true);
      for (const proibida of [
        'consultarAvisosPendentes',
        'consultarTeorComunicacao',
        'entregarManifestacao',
        'consultarAlteracao',
        'ciencia',
      ]) {
        expect(p.envelope.toLowerCase()).not.toContain(proibida.toLowerCase());
      }
    }
    // Um GET da descrição do serviço, sem credencial no endereço nem no corpo.
    expect(e.http.gets).toHaveLength(1);
    expect(e.http.gets[0]).not.toContain('senha');
  });

  it('o código da sonda não monta envelope nem chama o cliente HTTP por conta própria', () => {
    for (const arquivo of [
      'src/main/sonda/sondaMniPje.ts',
      'src/main/sonda/comandoSondaMniPje.ts',
      'scripts/sonda-mni-pje.mjs',
    ]) {
      const fonte = readFileSync(arquivo, 'utf8');
      expect(fonte, arquivo).not.toMatch(/envelopeConsultar|envelope\(/);
      expect(fonte, arquivo).not.toMatch(
        /consultarAvisosPendentes\s*\(|consultarTeorComunicacao\s*\(|entregarManifestacao\s*\(/,
      );
    }
    // O único POST sai do adaptador; a sonda só observa o status.
    expect(readFileSync('src/main/sonda/sondaMniPje.ts', 'utf8')).not.toMatch(
      /postXml|requisitar\(/,
    );
  });

  it('o adaptador do TJGO não mudou: SOAPAction do CNJ por padrão; "vazio" só por opção', async () => {
    const { MniAdapter } =
      await import('../../src/infrastructure/adapters/mni/MniAdapter.js');
    const { ACAO_CONSULTAR_PROCESSO } =
      await import('../../src/infrastructure/adapters/mni/mni.envelope.js');
    const padrao = new HttpFalsoDoPje();
    padrao.respostasDePost = [consultaPje({}, false)];
    await new MniAdapter({ httpClient: padrao }).consultarProcessoBruto(
      DIGITOS_SINTETICOS,
      { tribunal: 'TJGO', identificacao: 'x', senha: 'y' },
      { incluirCabecalho: true, incluirDocumentos: false },
    );
    expect(padrao.posts[0]?.acao).toBe(ACAO_CONSULTAR_PROCESSO);
    const vazio = new HttpFalsoDoPje();
    vazio.respostasDePost = [consultaPje({}, false)];
    await new MniAdapter({
      httpClient: vazio,
      soapAction: 'vazio',
    }).consultarProcessoBruto(
      DIGITOS_SINTETICOS,
      { tribunal: 'TJGO', identificacao: 'x', senha: 'y' },
      { incluirCabecalho: true, incluirDocumentos: false },
    );
    expect(vazio.posts[0]?.acao).toBe('""');
  });
});

describe('sonda do MNI do PJe — a credencial só em tempo de execução', () => {
  it.each([
    '--senha=abc123',
    '--cpf=00000000191',
    '--password=abc',
    '--token=abc',
    '--usuario=fulano',
  ])('recusa %s como argumento, sem repetir o valor', async (arg) => {
    const e = await rodar(() => undefined, {
      argv: [`--url=${URL_SINTETICA}`, `--processo=${NUMERO_SINTETICO}`, arg],
    });
    expect(e.codigo).toBe(2);
    expect(e.tudo).not.toContain(arg.split('=')[1]);
    expect(e.tudo).toContain('não é aceita como argumento');
    expect(e.http.posts).toHaveLength(0);
    expect(e.http.gets).toHaveLength(0);
  });

  it('as variáveis da sonda são APAGADAS do ambiente depois de lidas (o pdftotext herdaria o ambiente)', async () => {
    const env: Record<string, string | undefined> = {
      SONDA_MNI_CPF: CPF_SINTETICO,
      SONDA_MNI_SENHA: SENHA_SINTETICA,
      SONDA_MNI_URL: URL_SINTETICA,
      SONDA_MNI_PROCESSO: NUMERO_SINTETICO,
    };
    const e = await rodar(
      (h) => {
        h.respostasDePost = [consultaPje({}, false), consultaPje({})];
      },
      { argv: [], env },
    );
    expect(e.codigo).toBe(0);
    expect(Object.keys(env).filter((k) => k.startsWith('SONDA_MNI_'))).toEqual([]);
  });

  it('sem variável, a senha vem do prompt sem eco; o CPF com máscara vira só dígitos no pedido', async () => {
    const e = await rodar(
      (h) => {
        h.respostasDePost = [consultaPje({}, false), consultaPje({})];
      },
      {
        env: {},
        perguntas: {
          'CPF do consultante (sem eco): ': CPF_SINTETICO,
          'Senha do consultante (sem eco): ': SENHA_SINTETICA,
        },
      },
    );
    expect(e.codigo).toBe(0);
    expect(e.http.posts[0]?.envelope).toContain(
      `<tip:idConsultante>${CPF_SO_DIGITOS}</tip:idConsultante>`,
    );
  });

  it('sem credencial e sem terminal: erro de uso, nada é enviado', async () => {
    const e = await rodar(() => undefined, { env: {} });
    expect(e.codigo).toBe(2);
    expect(e.http.posts).toHaveLength(0);
    expect(e.http.gets).toHaveLength(0);
  });

  it.each([
    [['--processo=' + NUMERO_SINTETICO], 'Informe --url'],
    [[`--url=http://inseguro.test/x`, '--processo=' + NUMERO_SINTETICO], 'Informe --url'],
    [[`--url=${URL_SINTETICA}`, '--processo=1234'], 'número CNJ válido'],
    [
      [`--url=${URL_SINTETICA}`, '--processo=' + NUMERO_SINTETICO, '--timeout=1'],
      '--timeout',
    ],
    [
      [`--url=${URL_SINTETICA}`, '--processo=' + NUMERO_SINTETICO, '--soap-action=x'],
      '--soap-action',
    ],
    [
      [`--url=${URL_SINTETICA}`, '--processo=' + NUMERO_SINTETICO, '--outra=1'],
      'Argumento desconhecido',
    ],
  ])('uso incorreto %j: código 2, nada enviado', async (argv, trecho) => {
    const e = await rodar(() => undefined, { argv });
    expect(e.codigo).toBe(2);
    expect(e.tudo).toContain(trecho);
    expect(e.http.gets).toHaveLength(0);
  });

  it('a ajuda não consulta nada', async () => {
    const e = await rodar(() => undefined, { argv: ['--ajuda'] });
    expect(e.codigo).toBe(0);
    expect(e.saida.join('\n')).toBe(USO_DA_SONDA_MNI_PJE);
    expect(e.http.gets).toHaveLength(0);
  });

  it('número que não parece do TRT18: avisa e segue', async () => {
    const e = await rodar(
      (h) => {
        h.respostasDePost = [consultaPje({}, false), consultaPje({})];
      },
      { argv: [`--url=${URL_SINTETICA}`, '--processo=1234567-47.2023.8.26.0100'] },
    );
    expect(e.aviso.join('\n')).toContain('não parece ser de um processo do TRT18');
    expect(e.aviso.join('\n')).not.toContain('1234567');
  });

  it('SOAPAction "vazio" é repassado ao pedido', async () => {
    const e = await rodar(
      (h) => {
        h.respostasDePost = [consultaPje({}, false), consultaPje({})];
      },
      {
        argv: [
          `--url=${URL_SINTETICA}`,
          `--processo=${NUMERO_SINTETICO}`,
          '--soap-action=vazio',
        ],
      },
    );
    expect(e.http.posts[0]?.acao).toBe('""');
  });
});

describe('sonda do MNI do PJe — a saída só tem contagens e categorias', () => {
  const cenarios: Array<[string, (h: HttpFalsoDoPje) => void | Promise<void>]> = [
    [
      'sucesso',
      async (h) => {
        const pdf = await pdfComPaginas([TEXTO_SENTINELA.repeat(8)]);
        h.respostasDePost = [
          consultaPje({}, false),
          consultaPje({
            documentos: [{ id: ID_SENTINELA, bytes: pdf }, { id: 'sem-teor' }],
          }),
        ];
      },
    ],
    [
      'recusa que ecoa dados pessoais',
      (h) => {
        h.respostasDePost = [
          recusaPje(
            `Falha para ${NOME_SENTINELA}, CPF ${CPF_SINTETICO}, processo ${NUMERO_SINTETICO}, senha ${SENHA_SINTETICA}, veja https://pje.exemplo-sintetico.test/x`,
          ),
        ];
      },
    ],
    [
      'soap:Fault que ecoa a credencial',
      (h) => {
        h.respostasDePost = [
          texto(
            500,
            `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>Erro com ${SENHA_SINTETICA} para ${NOME_SENTINELA} ${DIGITOS_SINTETICOS}</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
          ),
        ];
      },
    ],
    [
      'erro de rede com URL e dados na mensagem',
      (h) => {
        h.respostasDePost = [
          new Error(`falhou ${URL_SINTETICA} ${SENHA_SINTETICA} ${CPF_SINTETICO}`),
        ];
      },
    ],
  ];

  it.each(cenarios)(
    'cenário "%s": nenhum sentinela na saída (stdout nem stderr)',
    async (_n, configurar) => {
      const e = await rodar(async (h) => {
        await configurar(h);
      });
      for (const s of SENTINELAS) expect(e.tudo, `vazou: ${s}`).not.toContain(s);
      // Nenhum resultado crú do relatório também.
      expect(e.tudo).not.toMatch(/\d{9,}/);
    },
  );

  it('o relatório estruturado também não carrega os sentinelas', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [
        recusaPje(`Erro ${NOME_SENTINELA} ${CPF_SINTETICO} ${NUMERO_SINTETICO}`),
      ];
    });
    expect(JSON.stringify(e.saida)).not.toContain(NOME_SENTINELA);
  });
});

describe('máscara das mensagens do tribunal', () => {
  it('tira credencial, número, CPF, e-mail, endereço, dígitos longos e pares de nomes; corta em 100 caracteres', () => {
    const m = mascararMensagemDoTribunal(
      `Erro para Maria Aparecida Souza, CPF 123.456.789-09, ${SENHA_SINTETICA}, maria@exemplo.test, ` +
        `processo 0011242-47.2021.5.18.0016, protocolo 998877, https://x.exemplo.test/a?b=1 ${'longo '.repeat(30)}`,
      [SENHA_SINTETICA],
    );
    expect(m).not.toContain('Maria');
    expect(m).not.toContain('123.456');
    expect(m).not.toContain(SENHA_SINTETICA);
    expect(m).not.toContain('@');
    expect(m).not.toContain('998877');
    expect(m).not.toContain('http');
    expect(m.length).toBeLessThanOrEqual(101);
  });

  it('classifica por frases, do mais específico ao mais geral', () => {
    expect(marcarMensagemDoTribunal('Certificado digital obrigatório')).toBe(
      'exige_certificado',
    );
    expect(marcarMensagemDoTribunal('Informe o segundo fator de autenticação')).toBe(
      'exige_segundo_fator',
    );
    expect(marcarMensagemDoTribunal('Senha inválida')).toBe('recusada');
    expect(marcarMensagemDoTribunal('Usuário sem perfil para o serviço')).toBe(
      'exige_cadastro_ou_perfil',
    );
    expect(marcarMensagemDoTribunal('Processo não encontrado')).toBe(
      'processo_nao_encontrado',
    );
    expect(marcarMensagemDoTribunal('Ocorreu algo estranho')).toBe('nao_classificada');
  });

  it('mensagem desconhecida sai mascarada e curta, nunca crua', async () => {
    const e = await rodar((h) => {
      h.respostasDePost = [
        recusaPje(`Falha misteriosa envolvendo ${NOME_SENTINELA} e o código 55512345`),
      ];
    });
    expect(umaLinhaCom(e, 'mensagem do tribunal (mascarada):')).toBe(true);
    expect(e.tudo).not.toContain('55512345');
    expect(e.tudo).not.toContain(NOME_SENTINELA);
    expect(e.http.posts).toHaveLength(1);
  });
});

describe('formatação do relatório', () => {
  it('linhasDoRelatorio só imprime campos do relatório', () => {
    const r = {
      versao: '1.0.0',
      conexao: { categoria: 'ok', statusHttp: 200, wsdl: null },
      autenticacao: { categoria: 'aceita' },
      consultaSemDocumentos: {
        categoria: 'ok',
        movimentos: 1,
        partes: 2,
        segredoDeJustica: false,
        mensagemMascarada: null,
      },
      consultaComDocumentos: {
        categoria: 'nao_executada',
        documentos: null,
        porTipo: null,
        comConteudo: null,
        somenteReferenciaSemConteudo: null,
        tamanhoKb: null,
        pdfs: null,
        mensagemMascarada: null,
      },
      avisosPendentes: 'nao_testado_por_risco_de_ciencia',
      veredito: 'viavel_com_ressalvas',
      ressalvas: ['x'],
      motivoDaInviabilidade: null,
    } satisfies RelatorioDaSonda;
    const txt = linhasDoRelatorio(r).join('\n');
    expect(txt).toContain('VEREDITO: viável com ressalvas');
    expect(txt).toContain('ressalva: x');
  });
});
