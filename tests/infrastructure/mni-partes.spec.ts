import { describe, expect, it } from 'vitest';
import {
  abrirEnvelope,
  contarPartes,
  extrairPartes,
} from '../../src/infrastructure/adapters/mni/mni.mapper.js';

/**
 * As partes do cabeçalho do MNI (v0.71.0).
 *
 * A FORMA é a da captura real do TJGO preservada em `mni-sem-habilitacao.spec.ts` (`polo polo="AT"`,
 * `parte > pessoa nome tipoPessoa numeroDocumentoPrincipal`, `advogado nome inscricao`); nomes,
 * documentos e inscrições são inventados. O caso que motivou: um cumprimento de sentença em que o
 * Diário só trazia o exequente (intimado) e o executado sumia da tela.
 */
function resposta(polos: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
<ns5:consultarProcessoResposta xmlns:ns2="http://www.cnj.jus.br/tipos-servico-intercomunicacao-2.2.2" xmlns:ns3="http://www.cnj.jus.br/intercomunicacao-2.2.2" xmlns:ns5="http://www.cnj.jus.br/servico-intercomunicacao-2.2.2/">
<ns2:sucesso>true</ns2:sucesso>
<ns2:processo>
<ns3:dadosBasicos numero="00000000000000000000" nivelSigilo="0">${polos}</ns3:dadosBasicos>
<ns3:movimento dataHora="20260901120000" identificadorMovimento="1"/>
</ns2:processo>
</ns5:consultarProcessoResposta>
</soap:Body>
</soap:Envelope>`;
}

const CUMPRIMENTO = resposta(`
<ns3:polo polo="AT">
<ns3:parte>
<ns3:pessoa nome="BANCO INVENTADO S.A" tipoPessoa="juridica" numeroDocumentoPrincipal="00000000000191"/>
<ns3:advogado nome="ADVOGADA FICTICIA" inscricao="99999-N-GO" numeroDocumentoPrincipal="00000000272" intimacao="true" tipoRepresentante="A"/>
</ns3:parte>
<ns3:parte>
<ns3:pessoa nome="ADVOGADA FICTICIA" tipoPessoa="fisica" numeroDocumentoPrincipal="00000000272"/>
<ns3:advogado nome="ADVOGADA FICTICIA" inscricao="99999-N-GO"/>
</ns3:parte>
</ns3:polo>
<ns3:polo polo="PA">
<ns3:parte>
<ns3:pessoa nome="FULANO DE TESTE" tipoPessoa="fisica" numeroDocumentoPrincipal="00000000353">
<ns3:endereco cep="00000000"><ns3:logradouro>Rua Inventada</ns3:logradouro></ns3:endereco>
</ns3:pessoa>
</ns3:parte>
</ns3:polo>`);

describe('partes do cabeçalho do MNI', () => {
  it('traz todas as partes dos autos, nos polos certos — inclusive quem o Diário não intimou', () => {
    const partes = extrairPartes(abrirEnvelope(CUMPRIMENTO).conteudo);
    expect(partes.map((p) => [p.polo, p.nome])).toEqual([
      ['ATIVO', 'BANCO INVENTADO S.A'],
      ['ATIVO', 'ADVOGADA FICTICIA'],
      ['PASSIVO', 'FULANO DE TESTE'],
    ]);
    expect(partes[0]?.tipoPessoa).toBe('JURIDICA');
    expect(partes[2]?.tipoPessoa).toBe('FISICA');
    expect(partes[0]?.advogados).toEqual([
      { nome: 'ADVOGADA FICTICIA', oab: '99999', ufOab: 'GO' },
    ]);
    expect(partes[2]?.advogados).toEqual([]);
    expect(contarPartes(abrirEnvelope(CUMPRIMENTO).conteudo)).toBe(3);
  });

  it('nunca leva CPF/CNPJ nem endereço, que o tribunal entrega sem máscara', () => {
    const json = JSON.stringify(extrairPartes(abrirEnvelope(CUMPRIMENTO).conteudo));
    for (const proibido of [
      '00000000000191',
      '00000000272',
      '00000000353',
      'Rua Inventada',
      'cep',
    ]) {
      expect(json).not.toContain(proibido);
    }
    expect(json).not.toContain('documento');
  });

  it('polo que não é ativo nem passivo vira OUTROS; parte sem nome é pulada; repetida no mesmo polo, uma vez', () => {
    const partes = extrairPartes(
      abrirEnvelope(
        resposta(`
<ns3:polo polo="TC"><ns3:parte><ns3:pessoa nome="TERCEIRO INVENTADO"/></ns3:parte></ns3:polo>
<ns3:polo polo="PA"><ns3:parte><ns3:pessoa nome=""/></ns3:parte>
<ns3:parte><ns3:pessoa nome="REU FICTICIO"/></ns3:parte><ns3:parte><ns3:pessoa nome="Reu Ficticio"/></ns3:parte></ns3:polo>`),
      ).conteudo,
    );
    expect(partes.map((p) => [p.polo, p.nome, p.tipoPessoa])).toEqual([
      ['OUTROS', 'TERCEIRO INVENTADO', 'DESCONHECIDO'],
      ['PASSIVO', 'REU FICTICIO', 'DESCONHECIDO'],
    ]);
  });

  it('sem cabeçalho, nenhuma parte (nunca inventa)', () => {
    const xml = resposta('').replace(/<ns3:dadosBasicos[^>]*><\/ns3:dadosBasicos>/, '');
    expect(extrairPartes(abrirEnvelope(xml).conteudo)).toEqual([]);
  });

  it.each([
    ['99999-N-GO', { oab: '99999', ufOab: 'GO' }],
    ['99999-A-', { oab: '99999' }],
    ['GO99999', { oab: '99999', ufOab: 'GO' }],
    ['99999/GO', { oab: '99999', ufOab: 'GO' }],
    ['099999 GO', { oab: '99999', ufOab: 'GO' }],
    ['99999', { oab: '99999' }],
    ['99999-XX', {}],
    ['123 456', {}],
    ['GO99999SP', {}],
    ['', {}],
  ])('lê a inscrição "%s" sem arriscar OAB errada', (inscricao, esperado) => {
    const partes = extrairPartes(
      abrirEnvelope(
        resposta(
          `<ns3:polo polo="AT"><ns3:parte><ns3:pessoa nome="AUTOR FICTICIO"/>` +
            `<ns3:advogado nome="ADV FICTICIO" inscricao="${inscricao}"/></ns3:parte></ns3:polo>`,
        ),
      ).conteudo,
    );
    expect(partes[0]?.advogados).toEqual([{ nome: 'ADV FICTICIO', ...esperado }]);
  });
});
