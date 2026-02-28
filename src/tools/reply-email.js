/**
 * reply-email.js — Ferramenta MCP para responder e-mails existentes (com threading)
 *
 * Usa o endpoint createReply para manter o thread, depois envia via /send.
 * Suporta responder apenas ao remetente (reply) ou a todos (reply-all).
 */

import { z } from "zod";
import { graphRequest, graphRequestPaginated } from "../graph.js";
import { checkRateLimit, registerAction } from "../guardrails.js";

export const replyEmailSchema = z.object({
  email_id: z
    .string()
    .optional()
    .describe(
      "ID do e-mail a ser respondido. Obtido via ler_emails. Se não informado, use busca_assunto para localizar."
    ),
  busca_assunto: z
    .string()
    .optional()
    .describe(
      "Texto para localizar o e-mail pelo assunto (busca na caixa de entrada). Usado quando email_id não está disponível."
    ),
  corpo: z.string().describe("Texto da resposta (texto simples ou HTML)"),
  html: z
    .boolean()
    .optional()
    .default(false)
    .describe("Se true, o corpo será enviado como HTML. Padrão: false (texto simples)"),
  responder_todos: z
    .boolean()
    .optional()
    .default(false)
    .describe("Se true, responde a todos os destinatários (reply all). Padrão: false (apenas ao remetente)"),
  cc: z
    .string()
    .optional()
    .describe("E-mails adicionais em cópia (CC) separados por vírgula. Opcional."),
  confirmacao: z
    .boolean()
    .optional()
    .default(false)
    .describe("Obrigatório true ao enviar o 11º e-mail da hora (ou múltiplos de 10)."),
});

export async function replyEmail(params) {
  const { email_id, busca_assunto, corpo, html, responder_todos, cc, confirmacao } = params;

  if (!email_id && !busca_assunto) {
    throw new Error("Informe email_id ou busca_assunto para localizar o e-mail a ser respondido.");
  }

  // 1. Verificar rate limit
  await checkRateLimit("email", confirmacao);

  // 2. Localizar o email_id se não foi informado diretamente
  let msgId = email_id;

  if (!msgId) {
    const endpoint = `/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$search=${encodeURIComponent(`"${busca_assunto}"`)}&$select=id,subject,from,receivedDateTime`;
    const result = await graphRequestPaginated(endpoint, 50);

    if (!result?.value?.length) {
      return `Nenhum e-mail encontrado com o assunto "${busca_assunto}" na caixa de entrada.`;
    }

    if (result.value.length > 1) {
      const lista = result.value.slice(0, 5).map((m, i) => {
        const data = new Date(m.receivedDateTime).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
        const de = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?";
        return `${i + 1}. ID: ${m.id}\n   Assunto: ${m.subject}\n   De: ${de} | ${data}`;
      }).join("\n\n");
      return (
        `Encontrados ${result.value.length} e-mails com "${busca_assunto}". Escolha um e informe o email_id:\n\n${lista}` +
        (result.value.length > 5 ? `\n\n... e mais ${result.value.length - 5} resultado(s).` : "")
      );
    }

    msgId = result.value[0].id;
  }

  // 3. Criar rascunho de resposta via createReply / createReplyAll (mantém threading)
  const replyEndpoint = responder_todos
    ? `/me/messages/${msgId}/createReplyAll`
    : `/me/messages/${msgId}/createReply`;

  const draft = await graphRequest("POST", replyEndpoint, {});

  if (!draft?.id) {
    throw new Error("Falha ao criar rascunho de resposta. Verifique se o email_id é válido.");
  }

  // 4. Atualizar o rascunho com o corpo da resposta (e CC opcional)
  const patchBody = {
    body: {
      contentType: html ? "HTML" : "Text",
      content: corpo,
    },
  };

  if (cc) {
    patchBody.ccRecipients = cc.split(",").map((e) => ({
      emailAddress: { address: e.trim() },
    }));
  }

  await graphRequest("PATCH", `/me/messages/${draft.id}`, patchBody);

  // 5. Enviar o rascunho
  await graphRequest("POST", `/me/messages/${draft.id}/send`, {});

  // 6. Registrar ação
  await registerAction("email");

  // Montar retorno amigável
  const tipoResposta = responder_todos ? "Responder a todos" : "Responder";
  const ccStr = cc ? ` | CC: ${cc}` : "";

  return `E-mail respondido com sucesso!\n- Tipo: ${tipoResposta}${ccStr}\n- Tamanho da resposta: ${corpo.length} caracteres`;
}
