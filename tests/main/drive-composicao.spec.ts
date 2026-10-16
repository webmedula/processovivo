import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cofre } from '../../src/infrastructure/seguranca/cofre.js';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { montarAplicacao } from '../../src/main/factories/makeProcessoSearchService.js';
import { QpdfMontador } from '../../src/infrastructure/pdf/QpdfMontador.js';

/*
 * O Drive no composition root e nas regras de dependência (v0.42.0). Sem rede: o adapter é
 * montado de verdade, mas nenhum teste o chama.
 */

const RAIZ = resolve(__dirname, '../..');

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory()
      ? arquivosTs(caminho)
      : caminho.endsWith('.ts')
        ? [caminho]
        : [];
  });
}
const fonte = (arq: string): string => readFileSync(arq, 'utf8');
const rel = (arq: string): string => relative(RAIZ, arq).replace(/\\/g, '/');

function montar(extra: Record<string, string>) {
  return montarAplicacao(
    carregarConfig({
      PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
      PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
      PROCESSOVIVO_DB_PATH: ':memory:',
      LOG_LEVEL: 'silent',
      SYNC_INTERVALO_HORAS: '0',
      VIGILANCIA_INTERVALO_HORAS: '0',
      BACKUP_INTERVALO_HORAS: '0',
      ...extra,
    } as NodeJS.ProcessEnv),
  );
}

const DRIVE_LIGADO = {
  PROCESSOVIVO_DRIVE_HABILITADO: 'true',
  GOOGLE_CLIENT_ID: 'cliente-sintetico.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'segredo-sintetico-do-cliente',
  PROCESSOVIVO_URL_BASE: 'https://app.exemplo.test',
  PROCESSOVIVO_CREDENCIAL_CHAVE: Cofre.gerarChaveBase64(),
};

describe('composition root — o Drive', () => {
  it('desligado por padrão: não há serviço de Drive', () => {
    const app = montar({ PROCESSOVIVO_CREDENCIAL_CHAVE: Cofre.gerarChaveBase64() });
    try {
      expect(app.drive).toBeUndefined();
    } finally {
      app.encerrar();
    }
  });

  it.skipIf(!QpdfMontador.disponivelSync('qpdf'))(
    'habilitado, com cofre e Pasta digital: o serviço existe',
    () => {
      const app = montar(DRIVE_LIGADO);
      try {
        expect(app.drive).toBeDefined();
        expect(app.pasta).toBeDefined();
      } finally {
        app.encerrar();
      }
    },
  );

  it('habilitado mas sem a Pasta digital (sem qpdf): NÃO sobe, em vez de existir e falhar no primeiro envio', () => {
    const app = montar({
      ...DRIVE_LIGADO,
      LEITOR_QPDF: 'qpdf-que-nao-existe-no-servidor',
    });
    try {
      expect(app.pasta).toBeUndefined();
      expect(app.drive).toBeUndefined();
    } finally {
      app.encerrar();
    }
  });
});

describe('o Drive e as regras de dependência', () => {
  it('só o adapter conhece o Google: nenhum outro arquivo de src/ cita googleapis.com', () => {
    const citam = arquivosTs(join(RAIZ, 'src'))
      .filter((a) => /googleapis\.com/.test(fonte(a)))
      .map(rel);
    expect(citam).toEqual(['src/infrastructure/adapters/drive/GoogleDriveAdapter.ts']);
  });

  it('o domínio e a aplicação do Drive não importam infraestrutura nem o adapter', () => {
    for (const arq of [
      'src/domain/entities/DestinoDePecas.ts',
      'src/domain/entities/nomeDoArquivoNoDrive.ts',
      'src/domain/ports/DestinoExternoDePecas.ts',
      'src/domain/ports/RepositorioDoDrive.ts',
      'src/application/services/ServicoDrive.ts',
      'src/application/services/fonteDePecasDaPasta.ts',
      'src/application/politicas/estadosDeConexao.ts',
    ]) {
      expect(fonte(join(RAIZ, arq)), arq).not.toMatch(
        /from\s+['"][^'"]*infrastructure\//,
      );
      expect(fonte(join(RAIZ, arq)), arq).not.toMatch(/from\s+['"][^'"]*\/main\//);
    }
  });

  it('o domínio do Drive não conhece o Google: a porta fala de "destino", não de Drive', () => {
    for (const arq of [
      'src/domain/entities/DestinoDePecas.ts',
      'src/domain/ports/DestinoExternoDePecas.ts',
    ]) {
      expect(
        fonte(join(RAIZ, arq)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
        arq,
      ).not.toMatch(/google/i);
    }
  });

  it('sem o SDK do Google: nenhuma dependência nova (googleapis, google-auth-library…)', () => {
    const pacote = JSON.parse(fonte(join(RAIZ, 'package.json'))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const todas = Object.keys({ ...pacote.dependencies, ...pacote.devDependencies });
    expect(todas.filter((d) => /google|gapi/i.test(d))).toEqual([]);
  });

  it('SÓ POR CLIQUE: o envio é iniciado por uma rota e por nenhum agendador, serviço ou CLI', () => {
    const quemChama = arquivosTs(join(RAIZ, 'src'))
      .filter((a) => /\.iniciarEnvio\(/.test(fonte(a)))
      .map(rel);
    expect(quemChama).toEqual(['src/main/http/rotas/drive.ts']);
  });

  it('o escopo pedido ao Google é um só, `drive.file`, e nenhum outro aparece no código', () => {
    const escopos = new Set<string>();
    for (const a of arquivosTs(join(RAIZ, 'src'))) {
      for (const m of fonte(a).matchAll(/googleapis\.com\/auth\/[a-z._-]+/g))
        escopos.add(m[0]);
    }
    expect([...escopos]).toEqual(['googleapis.com/auth/drive.file']);
  });

  it('sentido único: o adapter não tem listar, buscar, apagar, renomear nem compartilhar', () => {
    const codigo = fonte(
      join(RAIZ, 'src/infrastructure/adapters/drive/GoogleDriveAdapter.ts'),
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/metodo:\s*'DELETE'/);
    expect(codigo).not.toMatch(/\/permissions|\/copy|\/trash|[?&]q=|\/emptyTrash/);
    const porta = fonte(join(RAIZ, 'src/domain/ports/DestinoExternoDePecas.ts')).replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    for (const proibido of [
      'listar',
      'buscar',
      'apagar',
      'renomear',
      'compartilhar',
      'baixarArquivo',
      'lerArquivo',
    ]) {
      expect(porta, proibido).not.toContain(`${proibido}(`);
    }
  });

  it('o Drive não toca Atualizações, calendário, leitor nem IA: nenhum deles o importa', () => {
    for (const arq of arquivosTs(join(RAIZ, 'src')).map(rel)) {
      if (
        !/Calendario|calendario|ServicoLeitor|Analise|Resumo|Acompanhamento|atualizacoes|tabelaAtualizacoes/.test(
          arq,
        )
      )
        continue;
      if (arq.includes('drive')) continue;
      expect(fonte(join(RAIZ, arq)), arq).not.toMatch(
        /ServicoDrive|DestinoExternoDePecas|RepositorioDoDrive/,
      );
    }
  });
});
