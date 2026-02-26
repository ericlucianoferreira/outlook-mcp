# PRD — Guardrails de Segurança | outlook-mcp

**Versão:** 1.0
**Data:** 26/02/2026
**Status:** Aguardando aprovação

---

## Contexto

O MCP do Outlook opera com acesso direto à conta Microsoft 365. Sem proteções, uma instrução errada ou um loop de automação pode enviar centenas de e-mails, criar ou deletar eventos em massa. Este PRD define as regras de segurança a implementar.

---

## Escopo das Mudanças

### Arquivos afetados
```
src/
├── guardrails.js              ← NOVO: motor central de rate limit + validações
├── tools/
│   ├── send-email.js          ← Modificar: limite de destinatários + rate limit
│   ├── create-event.js        ← Modificar: anti-recorrência + rate limit + pergunta de convidados
│   ├── read-emails.js         ← Modificar: proibir ação de delete (já é só leitura — confirmar)
│   ├── list-events.js         ← Sem alteração necessária (só leitura)
│   ├── search-contacts.js     ← Sem alteração necessária (só leitura)
│   └── check-availability.js  ← Sem alteração necessária (só leitura)
.rate-limit.json                ← NOVO: persistência dos contadores em disco (gitignored)
.gitignore                      ← Atualizar: adicionar .rate-limit.json
```

**Nota:** Deletar e-mails e deletar/aceitar/recusar compromissos **não existem hoje** no MCP. O PRD garante que **não serão implementados no futuro** — as regras ficam documentadas em `guardrails.js` como exports de validação prontos para uso caso alguém tente adicionar essas features.

---

## Regras por Domínio

### 1. E-mail

| Regra | Detalhe |
|---|---|
| **Máx destinatários por envio** | Campo `para` aceita no máximo 5 endereços. Se vier mais de 5, rejeitar com erro claro. |
| **Rate limit** | Máximo 10 envios por janela de 1 hora. Contador independente por ferramenta. |
| **Confirmação ao atingir limite** | Ao tentar o 11º envio (ou múltiplos de 10 subsequentes), a ferramenta rejeita e retorna aviso. O próximo envio deve incluir `confirmacao: true` no payload para liberar **mais 10**. |
| **Deletar e-mail** | Proibido. Ferramenta não existe e não deve ser criada. |
| **Marcar lido/não lido** | Permitido (feature a ser criada: `marcar_email`). Sem rate limit — é ação reversível e de baixo risco. |

**Fluxo do rate limit de e-mail:**
```
Envio 1–10  → executa normalmente
Envio 11    → BLOQUEADO: "Limite de 10 e-mails/hora atingido.
               Para continuar, inclua confirmacao: true na próxima chamada."
Envio 11 com confirmacao: true → executa + reseta contador para 1
Envio 12–20 → executa normalmente
Envio 21    → BLOQUEADO novamente (mesma regra)
```

---

### 2. Compromissos

| Regra | Detalhe |
|---|---|
| **Anti-recorrência (criar)** | Proibido criar eventos com `recorrencia` ou qualquer campo de repetição. Schema não expõe esses campos. |
| **Anti-recorrência (deletar)** | Proibido deletar eventos recorrentes. Ao tentar deletar, verificar via Graph API se `seriesMasterId` existe — se sim, rejeitar. |
| **Anti-recorrência (aceitar/recusar)** | Aceitar/recusar eventos recorrentes é proibido. Verificar `seriesMasterId` antes de qualquer ação de resposta. |
| **Delete em massa** | Proibido. Deletar = 1 evento por chamada. Não há endpoint de delete em batch exposto. |
| **Rate limit (criação)** | Máximo 10 criações por janela de 1 hora. Mesmo modelo do e-mail — exige `confirmacao: true` no 11º. Contador independente do e-mail. |
| **Convidados ao criar** | A ferramenta `criar_compromisso` deve **sempre** incluir o campo `convidados` no schema como explicitamente opcional mas descrito como "Informe os e-mails dos convidados ou deixe vazio se não houver". O agente (Claude) deve perguntar antes de chamar a tool. |

**Fluxo verificação de recorrência ao deletar:**
```
Receber ID do evento
→ GET /me/events/{id}?$select=seriesMasterId,type
→ Se type === "seriesMaster" ou type === "occurrence" → BLOQUEAR
→ Se type === "singleInstance" → permitir
```

---

## Módulo Central: `src/guardrails.js`

Responsável por toda lógica de guardrail. As tools importam dele — não duplicam lógica.

### Interface pública

```js
// Rate limit
checkRateLimit(domain)         // 'email' | 'event' — lança erro se bloqueado sem confirmação
registerAction(domain)         // registra ação realizada no contador
resetWithConfirmation(domain)  // reseta contador quando confirmacao: true

// Validações de e-mail
validateRecipients(para)       // lança erro se > 5 destinatários

// Validações de evento
validateNotRecurring(eventData)  // lança erro se recorrência detectada no payload
// (verificação de recorrência no delete é feita via Graph API na tool, não aqui)
```

### Estrutura do `.rate-limit.json`

```json
{
  "email": {
    "count": 3,
    "window_start": "2026-02-26T14:00:00.000Z"
  },
  "event": {
    "count": 0,
    "window_start": "2026-02-26T14:00:00.000Z"
  }
}
```

**Lógica da janela:** ao registrar uma ação, verificar se `now - window_start >= 1 hora`. Se sim, resetar `count = 0` e `window_start = now` antes de incrementar.

---

## Nova Ferramenta: `marcar_email`

Permitida sem rate limit. Schema:

```js
{
  id:     string   // ID do e-mail (obtido via ler_emails)
  lido:   boolean  // true = marcar como lido | false = marcar como não lido
}
```

Endpoint: `PATCH /me/messages/{id}` com `{ "isRead": lido }`.

---

## O que NÃO será implementado (e por quê)

| Feature | Motivo |
|---|---|
| Deletar e-mail | Ação irreversível. Fora do escopo do MCP. |
| Criar evento recorrente | Alto risco de poluir calendário em loop. |
| Deletar evento recorrente | Pode apagar toda a série por engano. |
| Aceitar/recusar evento recorrente | Afeta todas as instâncias futuras. |
| Envio em batch / para lista | Coberto pelo limite de 5 destinatários por chamada. |

---

## Checklist de Implementação

- [ ] Criar `src/guardrails.js` com rate limit persistente + validações
- [ ] Atualizar `.gitignore` para incluir `.rate-limit.json`
- [ ] Atualizar `send-email.js`: validar destinatários + rate limit + param `confirmacao`
- [ ] Atualizar `create-event.js`: anti-recorrência + rate limit + param `confirmacao`
- [ ] Criar `src/tools/mark-email.js`: marcar lido/não lido
- [ ] Registrar `marcar_email` no `index.js`
- [ ] Atualizar testes em `test.js` para cobrir todos os guardrails
- [ ] Commit e push

---

## Mensagens de Erro Padrão

```
LIMITE_DESTINATARIOS: "Envio bloqueado: máximo de 5 destinatários por e-mail. Recebidos: {n}."

RATE_LIMIT_EMAIL: "Limite de 10 e-mails/hora atingido ({n} enviados).
Para continuar, inclua confirmacao: true na próxima chamada."

RATE_LIMIT_EVENT: "Limite de 10 criações de compromisso/hora atingido ({n} criados).
Para continuar, inclua confirmacao: true na próxima chamada."

EVENTO_RECORRENTE: "Operação bloqueada: este evento é recorrente (type: {type}).
Apenas instâncias únicas podem ser criadas, deletadas ou modificadas."
```

---

*Aprovado por: _______________  |  Data: _______________*
