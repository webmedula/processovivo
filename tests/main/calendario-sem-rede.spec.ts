import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * O calendário NÃO fala com tribunal. A detecção lê o que a sincronização já
 * gravou; o feed lê o banco. Uma importação de adaptador de rede em qualquer
 * módulo dele — direta ou por tabela — abriria o caminho para "só buscar o
 * processo de novo" num lugar que roda a cada sincronização e a cada leitura
 * de feed, com a credencial do advogado e a cota compartilhada do CNJ.
 *
 * O teste percorre o grafo de imports a partir dos módulos do calendário.
 */

const RAIZ = resolve(__dirname, '../..');

const MODULOS_DO_CALENDARIO = [
  'src/domain/entities/EventoDeCalendario.ts',
  'src/domain/entities/deteccaoDeEventos.ts',
  'src/domain/ports/RepositorioDeEventos.ts',
  'src/application/services/ServicoCalendario.ts',
  'src/application/services/ingestaoDoCalendario.ts',
  'src/infrastructure/persistencia/sqlite/RepositorioDeEventosSqlite.ts',
  'src/infrastructure/calendario/ics.ts',
  'src/main/http/rotas/calendario.ts',
  // v0.51.0: o resumo por e-mail só conhece a porta Notificador, nunca o adaptador SMTP.
  'src/application/services/ServicoResumoDoCalendario.ts',
  'src/application/politicas/mensagemDoResumoDoCalendario.ts',
  'src/infrastructure/persistencia/sqlite/RepositorioDoResumoDoCalendarioSqlite.ts',
];

/** Caminhos que são rede: os adaptadores das fontes (MNI, DataJud, DJEN, crawler) e o cliente HTTP. */
const PROIBIDOS_LOCAIS = [
  /^src\/infrastructure\/adapters\//,
  /^src\/infrastructure\/http\//,
];
const PROIBIDOS_PACOTES = /^(node:)?(http|https|net|tls|dgram)$|^undici$|^nodemailer$/;

function importsDe(arquivo: string): string[] {
  const fonte = readFileSync(resolve(RAIZ, arquivo), 'utf8');
  const achados: string[] = [];
  const re =
    /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = re.exec(fonte); m; m = re.exec(fonte)) achados.push(m[1] ?? m[2] ?? '');
  return achados;
}

function grafo(): { locais: Set<string>; pacotes: Set<string> } {
  const locais = new Set<string>();
  const pacotes = new Set<string>();
  const fila = [...MODULOS_DO_CALENDARIO];
  while (fila.length > 0) {
    const atual = fila.pop() as string;
    if (locais.has(atual)) continue;
    locais.add(atual);
    for (const alvo of importsDe(atual)) {
      if (!alvo.startsWith('.')) {
        pacotes.add(alvo);
        continue;
      }
      const ts = relative(RAIZ, resolve(RAIZ, dirname(atual), alvo)).replace(
        /\.js$/,
        '.ts',
      );
      fila.push(ts);
    }
  }
  return { locais, pacotes };
}

describe('calendário — nenhuma chamada a tribunal', () => {
  const { locais, pacotes } = grafo();

  it('o percurso alcança de fato os módulos (o teste não passa no vazio)', () => {
    expect(locais.has('src/domain/entities/Acompanhamento.ts')).toBe(true);
    expect(locais.size).toBeGreaterThan(MODULOS_DO_CALENDARIO.length);
  });

  it('nenhum módulo do calendário importa adaptador de fonte (MNI, DataJud, DJEN) nem o cliente HTTP', () => {
    const ruins = [...locais].filter((c) => PROIBIDOS_LOCAIS.some((re) => re.test(c)));
    expect(ruins).toEqual([]);
  });

  it('nem pacote de rede', () => {
    expect([...pacotes].filter((p) => PROIBIDOS_PACOTES.test(p))).toEqual([]);
  });

  it('nem usa fetch', () => {
    for (const c of locais) {
      expect(readFileSync(resolve(RAIZ, c), 'utf8')).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
