import { describe, expect, it } from 'vitest';
import {
  avisosDeRenomeacao,
  carregarConfig,
} from '../../src/infrastructure/config/env.js';

const CHAVE = 'chave-de-teste-1234567890';

function base(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { LOG_LEVEL: 'silent', ...extra } as NodeJS.ProcessEnv;
}

/*
 * O produto se chamava LexFlow até a v0.18.0, e as variáveis levavam esse nome.
 *
 * Renomear é o certo — ninguém quer ler LEXFLOW_ no painel de um sistema
 * chamado Processo Vivo. Mas uma renomeação seca transformaria a atualização
 * numa armadilha, e cada variável esquecida falharia de um jeito diferente:
 * sem a chave de API o processo nem sobe (barulhento, fácil de achar); sem a
 * chave do cofre as peças somem em silêncio; sem o caminho do banco o sistema
 * abre um arquivo NOVO e vazio ao lado do que tem os dados, e a carteira do
 * assinante parece ter evaporado.
 */
describe('variáveis de ambiente — nomes antigos continuam valendo', () => {
  it('aceita o nome antigo quando o novo não foi definido', () => {
    const config = carregarConfig(
      base({
        LEXFLOW_API_KEYS: CHAVE,
        LEXFLOW_DB_PATH: '/dados/antigo.db',
        LEXFLOW_URL_BASE: 'https://app.processovivo.com.br',
        LEXFLOW_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      }),
    );

    expect(config.http.chavesDeApi).toEqual([CHAVE]);
    expect(config.banco.caminho).toBe('/dados/antigo.db');
    expect(config.http.urlBase).toBe('https://app.processovivo.com.br');
    expect(config.cadeiaDeProviders).toEqual(['mock-crawler-tjsp']);
  });

  it('o nome NOVO vence quando os dois estão presentes', () => {
    // Quem já migrou deixa o antigo para trás no painel por descuido. O valor
    // velho não pode sobrescrever o novo — seria a migração se desfazendo
    // sozinha, e sem nada aparente.
    const config = carregarConfig(
      base({
        LEXFLOW_DB_PATH: '/dados/antigo.db',
        PROCESSOVIVO_DB_PATH: '/dados/novo.db',
        PROCESSOVIVO_API_KEYS: CHAVE,
      }),
    );

    expect(config.banco.caminho).toBe('/dados/novo.db');
  });

  it('relata cada nome antigo encontrado, para o log avisar o que trocar', () => {
    carregarConfig(base({ LEXFLOW_API_KEYS: CHAVE, LEXFLOW_DB_PATH: '/dados/x.db' }));

    expect(avisosDeRenomeacao()).toEqual([
      { antigo: 'LEXFLOW_API_KEYS', atual: 'PROCESSOVIVO_API_KEYS' },
      { antigo: 'LEXFLOW_DB_PATH', atual: 'PROCESSOVIVO_DB_PATH' },
    ]);
  });

  it('não relata nada quando tudo já usa o nome novo', () => {
    carregarConfig(base({ PROCESSOVIVO_API_KEYS: CHAVE }));

    expect(avisosDeRenomeacao()).toEqual([]);
  });

  it('variável antiga VAZIA não conta como definida', () => {
    // Easypanel deixa a linha vazia quando alguém apaga o valor sem apagar a
    // variável. Tratar isso como "definida" faria o aviso soar para sempre.
    carregarConfig(base({ LEXFLOW_URL_BASE: '', PROCESSOVIVO_API_KEYS: CHAVE }));

    expect(avisosDeRenomeacao()).toEqual([]);
  });
});
