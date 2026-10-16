import type {
  ArquivoNoDestino,
  AutorizacaoDoDestino,
  ConteudoParaEnvio,
  ResultadoDaPasta,
} from '../entities/DestinoDePecas.js';

/**
 * PORTA do destino externo das peças (v0.42.0): hoje o Google Drive do advogado.
 *
 * **O que a porta NÃO oferece é a decisão de produto.** Não há `listar`, não há
 * `buscarPorNome`, não há `apagar`, `renomear` nem `compartilhar`: o sistema só
 * grava, e só confere o que ele mesmo criou, pelo id que guardou. Uma porta que
 * oferecesse mais convidaria alguém a usar — e o escopo `drive.file` do Google,
 * que o sistema pede e é o único que pede, nem permitiria.
 *
 * Contrato de erros — implementadores DEVEM lançar tipos do domínio:
 *   - `AutorizacaoDoDestinoRevogadaError`  `invalid_grant`, escopo negado: reconectar
 *   - `AutorizacaoDoDestinoVencidaError`   401: renovar UMA vez e repetir
 *   - `DestinoSemEspacoError`              o destino está cheio: o lote para
 *   - `DestinoLimitouError`                429 / limite de uso (com `esperarMs`)
 *   - `DestinoIndisponivelError`           rede, timeout, 5xx: transitório
 *   - `DestinoRecusouError`                outro 4xx
 *   - `PastaRemovidaNoDestinoError`        o pai do envio não existe mais
 *   - `ArquivoRemovidoNoDestinoError`      o arquivo a atualizar não existe mais
 * Nenhum carrega texto do Google nem credencial. `healthCheck` NUNCA lança.
 */
export interface DestinoExternoDePecas {
  /** Estável: vai para log e procedência. */
  readonly nome: string;

  /**
   * O endereço para onde o advogado vai autorizar. `estado` é o parâmetro
   * anti-CSRF (assinado e de uso único, gerado por quem chama) e `desafio` o
   * desafio PKCE. Não consulta ninguém.
   */
  iniciarConexao(entrada: {
    readonly estado: string;
    readonly desafio: string;
    readonly uriDeRetorno: string;
  }): { readonly url: string };

  /**
   * Troca o código recebido no retorno pela autorização. Exige que a permissão
   * da pasta tenha sido concedida (o consentimento granular permite desmarcá-la).
   * @throws {AutorizacaoDoDestinoRevogadaError} código recusado ou escopo negado.
   */
  concluirConexao(entrada: {
    readonly codigo: string;
    readonly verificador: string;
    readonly uriDeRetorno: string;
  }): Promise<AutorizacaoDoDestino>;

  /**
   * Renova a autorização vencida (ou prestes a vencer). O token de renovação
   * antigo continua valendo quando o destino não manda um novo.
   * @throws {AutorizacaoDoDestinoRevogadaError} `invalid_grant`.
   */
  renovarAutorizacao(autorizacao: AutorizacaoDoDestino): Promise<AutorizacaoDoDestino>;

  /**
   * Garante uma pasta. Com `idConhecido`, confere que ela ainda existe e não
   * está na lixeira; se sumiu, cria UMA nova (`recriada: true`). Nunca procura
   * pasta pelo nome: o escopo não permite listar, e procurar duplicaria.
   */
  garantirPasta(
    autorizacao: AutorizacaoDoDestino,
    pedido: {
      readonly nome: string;
      readonly paiId?: string;
      readonly idConhecido?: string;
    },
  ): Promise<ResultadoDaPasta>;

  /** Existe e não está na lixeira? Uma consulta pelo id que o sistema guardou. */
  conferirArquivo(
    autorizacao: AutorizacaoDoDestino,
    arquivoId: string,
  ): Promise<'existe' | 'removido'>;

  /**
   * Cria o arquivo na pasta, ou — com `arquivoId` — atualiza o conteúdo e o nome
   * do MESMO arquivo. Multipart simples para arquivo pequeno, resumível para o
   * grande (o limite é do adapter).
   */
  enviarArquivo(
    autorizacao: AutorizacaoDoDestino,
    pedido: {
      readonly nome: string;
      readonly paiId: string;
      readonly mimetype: string;
      readonly conteudo: ConteudoParaEnvio;
      readonly descricao?: string;
      readonly arquivoId?: string;
    },
  ): Promise<ArquivoNoDestino>;

  /** Revoga a autorização no destino. Melhor esforço: nunca lança. */
  desconectar(autorizacao: AutorizacaoDoDestino): Promise<void>;

  /** Nunca lança: destino fora do ar devolve `false`. */
  healthCheck(): Promise<boolean>;
}
