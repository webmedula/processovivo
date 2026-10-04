import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  DiagnosticoNotificador,
  Mensagem,
  Notificador,
} from '../../domain/ports/Notificador.js';

export interface OpcoesEmailSmtp {
  readonly host: string;
  readonly porta: number;
  readonly usuario?: string;
  readonly senha?: string;
  /** TLS direto (porta 465). Em 587 o padrão é STARTTLS, que o nodemailer negocia. */
  readonly seguro?: boolean;
  /** Remetente. Precisa ser um endereço que o servidor SMTP autorize. */
  readonly remetente: string;
  readonly logger: Logger;
}

/**
 * Notificação por e-mail, via SMTP.
 *
 * SMTP e não a API de um provedor (Resend, SendGrid, SES) por dois motivos:
 * funciona com qualquer serviço — inclusive o SMTP que ele já tem no domínio,
 * sem cadastro novo — e não amarra o produto a um fornecedor que amanhã muda
 * preço ou fecha a conta por volume.
 *
 * E-mail é o PRIMEIRO canal, antes do WhatsApp, por três razões concretas:
 * não depende de template aprovado pela Meta, cabe o inteiro teor de uma
 * decisão de 20 mil caracteres, e advogado já lê intimação no e-mail — o hábito
 * existe.
 */
export class EmailSmtpNotificador implements Notificador {
  readonly nome = 'email-smtp';
  readonly habilitado = true;

  private readonly transporte: Transporter;
  private readonly remetente: string;
  private readonly log: Logger;

  constructor(opcoes: OpcoesEmailSmtp) {
    this.remetente = opcoes.remetente;
    this.log = opcoes.logger.child({ notificador: this.nome });
    this.transporte = createTransport({
      host: opcoes.host,
      port: opcoes.porta,
      secure: opcoes.seguro ?? opcoes.porta === 465,
      ...(opcoes.usuario
        ? { auth: { user: opcoes.usuario, pass: opcoes.senha ?? '' } }
        : {}),
    });
  }

  /**
   * Nunca lança — contrato da porta. Uma varredura que descobriu seis novidades
   * e as gravou não pode ser desfeita porque o servidor de e-mail recusou a
   * conexão: o dado está salvo, o que se perdeu foi o aviso, e é isso que o
   * log precisa dizer.
   */
  async enviar(mensagem: Mensagem): Promise<boolean> {
    try {
      await this.transporte.sendMail({
        from: this.remetente,
        to: mensagem.para,
        subject: mensagem.assunto,
        text: mensagem.texto,
        ...(mensagem.html ? { html: mensagem.html } : {}),
      });
      return true;
    } catch (erro) {
      // O endereço de destino NÃO vai para o log: é dado pessoal do assinante e
      // log costuma ir para serviço de terceiro. O assunto basta para achar
      // qual envio falhou.
      this.log.warn('falha ao enviar e-mail', {
        assunto: mensagem.assunto,
        erro: erro instanceof Error ? erro.message : String(erro),
      });
      return false;
    }
  }

  /**
   * Abre a conexão, autentica e desliga — sem mandar mensagem.
   *
   * A maior parte das falhas de SMTP acontece ANTES de existir mensagem:
   * porta bloqueada na saída do VPS, senha errada, TLS na porta errada. Tentar
   * enviar para descobrir isso mistura os dois problemas e ainda deixa dúvida
   * sobre o destinatário ter recebido.
   */
  async diagnosticar(): Promise<DiagnosticoNotificador> {
    try {
      await this.transporte.verify();
      return { ok: true };
    } catch (erro) {
      const codigo = codigoDoErro(erro);
      return {
        ok: false,
        motivo: explicarFalhaSmtp(codigo, erro),
        ...(codigo ? { codigo } : {}),
      };
    }
  }

  /** Fecha o pool de conexões no desligamento gracioso. */
  encerrar(): void {
    this.transporte.close();
  }
}

function codigoDoErro(erro: unknown): string | undefined {
  if (typeof erro !== 'object' || erro === null) return undefined;
  const c = (erro as { code?: unknown }).code;
  const r = (erro as { responseCode?: unknown }).responseCode;
  if (typeof c === 'string') return c;
  if (typeof r === 'number') return String(r);
  return undefined;
}

/**
 * Traduz o erro do nodemailer para a causa provável e o que mexer.
 *
 * Duas regras aprendidas testando isto contra falhas reais:
 *
 * 1. **Olhe a mensagem, não só o código.** O nodemailer usa `ESOCKET` tanto
 *    para falha de TLS quanto para conexão recusada — problemas com consertos
 *    opostos. A primeira versão desta função via `ESOCKET` e culpava o TLS;
 *    contra uma porta fechada, mandava quem lê mexer em `SMTP_SECURE` enquanto
 *    o problema era a porta. Tradução que chuta é pior que o erro cru, porque
 *    o erro cru pelo menos não desperdiça meia hora.
 *
 * 2. **Quando não der para distinguir, não invente.** O texto original vai
 *    junto sempre, e o palpite só aparece quando há evidência para ele.
 */
function explicarFalhaSmtp(codigo: string | undefined, erro: unknown): string {
  const bruto = erro instanceof Error ? erro.message : String(erro);
  const texto = bruto.toLowerCase();

  const contem = (...termos: string[]): boolean =>
    termos.some((t) => texto.includes(t));

  // A mensagem vem primeiro: ela carrega a causa real quando o código é
  // ambíguo.
  if (contem('econnrefused')) {
    return `a conexão foi RECUSADA — há rede até o servidor, e a porta está fechada. Confira SMTP_PORT (tente 465 com SMTP_SECURE=true) e se o VPS não bloqueia a saída nessa porta. — ${bruto}`;
  }
  if (contem('etimedout', 'timeout', 'ehostunreach', 'enetunreach')) {
    return `a conexão expirou sem resposta — sinal típico de porta bloqueada na SAÍDA do VPS. Muitos provedores fecham 25 e 587 contra spam; 465 costuma passar (com SMTP_SECURE=true). — ${bruto}`;
  }
  if (contem('enotfound', 'getaddrinfo', 'eai_again')) {
    return `o endereço do servidor não resolve. Confira SMTP_HOST — e lembre que, se o domínio passar a apontar para o VPS, o nome do site deixa de servir como servidor de e-mail. — ${bruto}`;
  }
  // As falhas de TLS se parecem e têm consertos completamente diferentes. A
  // primeira versão desta função agrupava todas sob "SMTP_SECURE trocado", e
  // contra um certificado VENCIDO no servidor de e-mail mandava mexer numa
  // variável que não tinha relação nenhuma com o problema. Mesmo erro da
  // versão anterior, um nível mais fundo: casar por palavra solta
  // ("certificate") em vez da frase inteira volta a ser chute.
  if (contem('certificate has expired', 'certexpired')) {
    return `o certificado TLS do servidor de e-mail está VENCIDO. Não é configuração daqui: é preciso renovar o certificado no servidor (no CyberPanel, SSL > Hostname/Mail Server SSL). — ${bruto}`;
  }
  if (contem('self-signed', 'self signed', 'unable to verify', 'leaf signature')) {
    return `o certificado do servidor de e-mail não é confiável — autoassinado ou com cadeia incompleta. Emita um certificado válido para o host de e-mail no servidor. — ${bruto}`;
  }
  if (contem('altname', 'hostname/ip does not match', 'does not match certificate')) {
    return `o nome no certificado não corresponde ao SMTP_HOST. Use no SMTP_HOST exatamente o nome para o qual o certificado foi emitido. — ${bruto}`;
  }
  if (contem('wrong version number', 'packet length', 'record layer')) {
    return `TLS na porta errada. É SMTP_SECURE trocado: true SÓ na porta 465; em 587 o TLS é negociado por STARTTLS e o valor tem que ser false. — ${bruto}`;
  }

  switch (codigo) {
    case 'EAUTH':
    case '535':
    case '534':
      return `o servidor recusou usuário e senha. Confira SMTP_USER (costuma ser o endereço completo, não só o nome antes do @) e SMTP_PASS. — ${bruto}`;
    case 'EENVELOPE':
    case '550':
    case '553':
      return `o servidor recusou o remetente ou o destinatário. SMTP_FROM precisa ser um endereço que este servidor tenha autorização para enviar. — ${bruto}`;
    default:
      // Sem evidência para palpite: entrega o texto original e não inventa.
      return bruto;
  }
}

/**
 * Notificador que escreve no log em vez de enviar.
 *
 * Para desenvolvimento e para o caso de SMTP não configurado em produção: o
 * sistema continua exercitando todo o caminho — detecta, monta o resumo, "envia"
 * — e o operador vê no log exatamente o que teria saído. Melhor do que desligar
 * a funcionalidade e descobrir que ela nunca funcionou no dia em que ligar.
 */
export class LogNotificador implements Notificador {
  readonly nome = 'log';
  readonly habilitado = true;

  constructor(private readonly log: Logger) {}

  async enviar(mensagem: Mensagem): Promise<boolean> {
    this.log.info('notificação (SMTP não configurado — nada foi enviado)', {
      assunto: mensagem.assunto,
      linhas: mensagem.texto.split('\n').length,
    });
    return true;
  }
}
