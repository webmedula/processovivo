import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Peca } from '../../src/domain/entities/Peca.js';
import type { ConteudoPeca } from '../../src/domain/entities/Peca.js';
import { CredencialTribunalInvalidaError } from '../../src/domain/errors/index.js';
import type {
  CredencialTribunal,
  ProvedorDePecas,
} from '../../src/domain/ports/ProvedorDePecas.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import type { Config } from '../../src/infrastructure/config/env.js';
import { construirServidor } from '../../src/main/http/servidor.js';
import { aplicacaoDeTeste } from '../helpers/aplicacao.js';
import { ProviderFalso } from '../helpers/fabricas.js';

const CHAVE = 'chave-de-teste-1234567890';
/** Processo real do TJGO — dígito verificador válido. */
const PROCESSO = '5818922-04.2026.8.09.0011';

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x0a]);

class ProvedorFalsoDePecas implements ProvedorDePecas {
  readonly nome = 'mni-falso';
  readonly tribunais = ['TJGO'];
  recusar = false;

  async listarPecas(_numero: string, _credencial: CredencialTribunal): Promise<Peca[]> {
    if (this.recusar) {
      throw new CredencialTribunalInvalidaError(this.nome, 'Usuário ou Senha inválida.');
    }
    return [
      new Peca({
        id: 'doc-1',
        tipo: '57',
        tipoLocal: 'Petição Inicial',
        mimetype: 'application/pdf',
        conteudoDisponivel: true,
      }),
      new Peca({
        id: 'doc-2',
        tipo: '60',
        tipoLocal: 'Despacho',
        mimetype: 'application/pdf',
        conteudoDisponivel: false,
      }),
    ];
  }

  async obterConteudo(): Promise<ConteudoPeca> {
    return {
      id: 'doc-1',
      mimetype: 'application/pdf',
      nomeArquivo: 'peca.pdf',
      bytes: new Uint8Array(PDF),
    };
  }
}

function config(): Config {
  return carregarConfig({
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: CHAVE,
    CACHE_ENABLED: 'false',
  } as NodeJS.ProcessEnv);
}

function montar(provedor?: ProvedorDePecas): FastifyInstance {
  const app = aplicacaoDeTeste([new ProviderFalso({ nome: 'falso' })], {
    ...(provedor ? { provedorDePecas: provedor } : {}),
  });
  return construirServidor(app, config());
}

const cabecalhos = { 'x-api-key': CHAVE };

describe('API — peças', () => {
  let servidor: FastifyInstance;
  let provedor: ProvedorFalsoDePecas;

  beforeEach(() => {
    provedor = new ProvedorFalsoDePecas();
    servidor = montar(provedor);
  });
  afterEach(async () => {
    await servidor.close();
  });

  async function cadastrarCredencial(): Promise<void> {
    await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: cabecalhos,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
  }

  it('responde 428 quando não há credencial cadastrada', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    // 428 e não 401: a autenticação no Processo Vivo está boa; falta o acesso DELE no
    // tribunal. 401 mandaria o cliente refazer login, que não resolve nada.
    expect(r.statusCode).toBe(428);
    expect(r.json().erro).toBe('CREDENCIAL_TRIBUNAL_AUSENTE');
  });

  it('lista as peças e conta quantas têm arquivo', async () => {
    await cadastrarCredencial();
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(2);
    // As DUAS têm arquivo: `conteudoDisponivel` false só diz que o teor não
    // veio junto da ficha — no MNI nunca vem. Contar por ele daria 1 aqui e
    // ZERO contra o tribunal de verdade, escondendo o processo inteiro.
    expect(r.json().comArquivo).toBe(2);
  });

  it('classifica a origem da peça sem esconder nenhuma', async () => {
    await cadastrarCredencial();
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    const origens = r.json().pecas.map((p: { origem: string }) => p.origem);
    expect(origens).toEqual(['PARTE', 'JUIZO']);
  });

  it('entrega o arquivo como anexo, com os bytes intactos', async () => {
    await cadastrarCredencial();
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas/doc-1`,
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(r.rawPayload).equals(PDF)).toBe(true);
  });

  it('devolve 424 quando o tribunal recusa a credencial', async () => {
    await cadastrarCredencial();
    provedor.recusar = true;

    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    // Nem 401 (nossa autenticação está boa) nem 502 (o tribunal respondeu bem —
    // recusou). A ação é outra: alguém precisa atualizar a senha.
    expect(r.statusCode).toBe(424);
    expect(r.json().erro).toBe('CREDENCIAL_TRIBUNAL_INVALIDA');
  });

  it('marca a credencial como recusada, para a interface poder avisar', async () => {
    await cadastrarCredencial();
    provedor.recusar = true;
    await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/credenciais',
      headers: cabecalhos,
    });
    expect(r.json().credenciais[0].recusadaEm).not.toBeNull();
  });

  it('nunca devolve a senha cadastrada', async () => {
    await cadastrarCredencial();

    const criacao = await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: cabecalhos,
      payload: { tribunal: 'TJGO', identificacao: '00000000000', senha: 'segredo' },
    });
    const listagem = await servidor.inject({
      method: 'GET',
      url: '/v1/credenciais',
      headers: cabecalhos,
    });

    expect(criacao.body).not.toContain('segredo');
    expect(listagem.body).not.toContain('segredo');
  });

  it('recusa cadastro sem senha', async () => {
    const r = await servidor.inject({
      method: 'PUT',
      url: '/v1/credenciais',
      headers: cabecalhos,
      payload: { tribunal: 'TJGO', identificacao: '00000000000' },
    });

    expect(r.statusCode).toBe(400);
  });

  it('remove a credencial e informa quando não havia nada a remover', async () => {
    await cadastrarCredencial();
    const primeira = await servidor.inject({
      method: 'DELETE',
      url: '/v1/credenciais/TJGO',
      headers: cabecalhos,
    });
    const segunda = await servidor.inject({
      method: 'DELETE',
      url: '/v1/credenciais/TJGO',
      headers: cabecalhos,
    });

    expect(primeira.statusCode).toBe(200);
    expect(segunda.statusCode).toBe(404);
  });

  it('recusa peças de tribunal fora do alcance da fonte', async () => {
    await cadastrarCredencial();
    // Processo do TJSP: a fonte configurada só atende TJGO.
    const r = await servidor.inject({
      method: 'GET',
      url: '/v1/processos/1234567-47.2023.8.26.0100/pecas',
      headers: cabecalhos,
    });

    expect(r.statusCode).toBe(501);
    expect(r.json().erro).toBe('OPERACAO_NAO_SUPORTADA');
  });

  it('exige autenticação', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('API — peças sem o serviço montado', () => {
  let servidor: FastifyInstance;

  beforeEach(() => {
    servidor = montar();
  });
  afterEach(async () => {
    await servidor.close();
  });

  it('responde 501 com a instrução, em vez de lista vazia', async () => {
    const r = await servidor.inject({
      method: 'GET',
      url: `/v1/processos/${PROCESSO}/pecas`,
      headers: cabecalhos,
    });

    // Lista vazia diria ao advogado que o processo não tem peças, quando o que
    // falta é configuração do servidor.
    expect(r.statusCode).toBe(501);
    expect(r.json().mensagem).toContain('PROCESSOVIVO_CREDENCIAL_CHAVE');
  });
});
