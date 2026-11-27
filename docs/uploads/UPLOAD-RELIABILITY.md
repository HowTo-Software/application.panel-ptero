# Confiabilidade de upload de arquivos / File upload reliability

> Investigação de 2026-11-27 no node1 (servidor `26df09e1`, diretório `/mods/deathmatch/backups`, RAR de ~152,78 MiB).
> **Português primeiro, resumo em inglês no final.** Tudo marcado como *medido* foi observado de fato; *hipótese* é inferência
> ainda não confirmada; *design* é proposta sem implementação.

## 1. Resumo executivo

| Sintoma | Causa | Estado |
|---|---|---|
| Painel mostra `The requested resource was not found on this server.` | **Não é arquivo ausente.** É o texto que o **Wings** devolve (404) quando o token de upload é de uso único e já foi usado, está revogado, sem escopo, ou o servidor não está carregado no node. | Texto e condições **confirmados no código do Wings v1.13.4**. Que o gatilho real seja uma requisição reenviada com o mesmo token é **hipótese** (ver §4). |
| Upload "extremamente lento" | Uma única conexão TCP sobre um caminho com perda de pacotes e RTT alto. **Medido:** ~0,35–0,6 MB/s, com retransmissões. O node não é o gargalo. | Medido (§3). |
| Arquivo aparece com 152,78 MiB mas "não foi confirmado" / some do diretório | O Wings grava **direto no nome final** (`O_TRUNC`), só faz `chown` ao final e, em qualquer erro, **apaga por caminho**. Duas tentativas para o mesmo nome se destroem. | Código **confirmado**; colisão real é **hipótese forte** (§4). |
| Erro real escondido na UI | `Promise.all` + `catch` único: o 1º erro limpa a lista de progresso de **todos** os arquivos e mostra só uma frase genérica. Sem velocidade/ETA, sem retentativa. | Código **confirmado**. |

**O código de upload do nosso painel é idêntico ao upstream** (diferença só do `translateUiText`; `FileUploadController` é byte a byte igual). Portanto **não há regressão das nossas customizações** nesse fluxo: os defeitos são do desenho upstream e da rede.

## 2. Fluxo de upload (de ponta a ponta)

```
Navegador ──GET /api/client/servers/{uuid}/files/upload──► Painel (nginx → PHP)      devolve URL assinada (JWT, 15 min)
Navegador ──POST https://node1…:8443/upload/file?token=…──► Wings (TLS direto, sem nginx)   corpo multipart, vai direto ao disco
Navegador ──GET /api/client/servers/{uuid}/files/list──► Painel → Wings                 atualiza a lista
```

* O **corpo do arquivo não passa** pelo nginx/PHP do painel nem por proxies do painel. Limites `client_max_body_size`/`upload_max_filesize`/`post_max_size` **não se aplicam** ao upload (só à pequena chamada que gera a URL).
* No node1 o Wings escuta **diretamente na 8443** (*medido*: `ss`, `systemctl is-active nginx cloudflared` = `inactive`).
* Se o FQDN do node estiver **proxied pelo Cloudflare** (nuvem laranja), o Cloudflare limita o corpo a 100 MB (Free/Pro) / 200 MB (Business) / 500 MB (Enterprise) e responderia **413**, não 404. *Medido:* a resolução DNS que usei apontou para IP não-Cloudflare, mas **vimos uma conexão de IP Cloudflare na 8443**; confirme no painel do Cloudflare que o registro do node é **DNS only**.

## 3. O que foi medido no node1 (somente leitura)

* Wings **v1.13.4**. Host: 36 CPUs, ~253 GB RAM (≈208 GB livres), NVMe com ≈735 GB livres, load ≈1,8 → **sem pressão de CPU/RAM/disco**.
* `wings.log` (nível padrão registra só erros): **6** erros de `POST /upload/file`, todos **do lado do cliente**: `stream error: stream ID N; CANCEL` (HTTP/2 cancelado pelo navegador) ou `client disconnected`. O Wings **não** falhou por conta própria. *(404 não aparece no log: o Wings devolve 404 com `AbortWithStatusJSON`, que não é registrado.)*
* Duas amostras de `ss -ti` na conexão de upload ativa:
  * 152 975 757 → 166 274 753 B em ≈22 s ⇒ **≈0,6 MB/s**;
  * 256 834 860 → 266 033 480 B em ≈26 s ⇒ **≈0,35 MB/s**;
  * RTT ≈115–155 ms; 613 retransmissões numa conexão; **10 195** noutra, com `rto` em backoff (conexão "zumbi", sem dados há ~10 min). A janela de recepção do node (≈5 MB) comportaria dezenas de MB/s com esse RTT, então **o limite está no caminho/cliente**, não no node.
* Às **08:14** o RAR estava em disco com **128 038 331 B, dono `root`** (o `chown` para o usuário do servidor só ocorre ao final do upload, então `root` = **incompleto**). Às **08:15:04.525** o diretório mudou (arquivo removido) e **2 ms depois** o Wings registrou `client disconnected` no `/upload/file`. Depois disso o diretório ficou **vazio** enquanto outra conexão continuava recebendo bytes (≈0,35 MB/s) e **nenhum arquivo >1 MB crescia em nenhum volume do node**.

> **Hipótese (não confirmada, exige root):** a conexão ativa gravava num *inode já apagado*, porque o handler antigo removeu o caminho. Para confirmar, como root no node: `ls -l /proc/$(pgrep -x wings)/fd | grep deleted`.

## 4. Causa raiz (código do Wings v1.13.4)

`router/router_server_files.go` e `server/filesystem/filesystem.go`:

1. **404 enganoso** (`postServerUploadFiles`, linha ~577): `!ok || token.Denylisted() || !token.IsUniqueRequest() || !token.HasScope(...)` → 404 `"The requested resource was not found on this server."`. `IsUniqueRequest` consome o `unique_id` do JWT: **o token vale uma única requisição**. Qualquer reenvio com o mesmo token (por exemplo, o navegador reenviando uma requisição cuja conexão keep-alive foi resetada antes de qualquer resposta) recebe 404. A UI mostra isso como se o arquivo não existisse.
2. **Escrita no nome final** (`WriteFrom`, linhas 252-277): `Touch(O_TRUNC)` no caminho final → `io.Copy` → `chown` só no fim → em **qualquer** erro, `Remove(p)` **por caminho**. Consequências:
   * o arquivo antigo com o mesmo nome é **destruído no primeiro byte** do novo upload;
   * um handler antigo que falha tarde (`client disconnected` pode levar minutos num TCP morto) **apaga o arquivo da tentativa nova**;
   * um upload interrompido deixa (ou remove) dados sem nenhum indicador de "completo".
3. **Sem retomada nem fragmentação**: um único POST multipart; falhou, recomeça do zero.
4. **Limite do node**: `api.upload_limit` (MB) em `config.yml`, aplicado com `io.LimitReader(limit+1)`; acima disso → 400 `File X is larger than the maximum file upload size of N MB.` (o painel só preenche esse valor ao gerar a configuração; um ajuste manual no `config.yml` **não** altera o banco).
5. **Cota de disco**: aplicada durante a escrita (`WriteFrom` documenta checagem "against the disk limit as it happens"); falha remove o arquivo.

No painel (`UploadButton.tsx` antes desta mudança): `Promise.all` de todos os arquivos ao mesmo tempo, sem limite de paralelismo; um token por arquivo obtido no início; `catch` único chama `clearFileUploads()` (apaga o progresso de **todos**) e mostra uma frase; nenhuma retentativa; nenhum timeout de inatividade (uma conexão morta fica pendurada até o TCP desistir); `mutate()` não roda se algo falhar.

## 5. O que esta PR muda (somente painel — sem alterar Wings nem produção)

Tudo usa **apenas endpoints existentes** (compatível com Wings atual, com SFTP e com servidores existentes; sem migração de banco).

| Mudança | Efeito |
|---|---|
| Token **novo a cada tentativa** (`getFileUploadUrl` por tentativa) | Elimina o 404 por token reutilizado em retentativas. |
| Upload para **nome temporário único** (`<nome>.<id>.part`) e `rename` ao final | O nome final só aponta para arquivo **completo**; tentativa antiga/duplicada só consegue apagar o **próprio** temporário; arquivo existente **não é destruído** no início. Exige `file.update` (e `file.delete` p/ substituir); sem isso, cai no upload direto antigo. Nomes que estourariam 255 bytes usam upload direto. |
| **Verificação de integridade**: lista o diretório e compara `size` do remoto com o local antes de renomear; depois do rename confirma de novo (o Wings responde sucesso a rename de origem inexistente) | Arquivo incompleto **nunca** é marcado como concluído. |
| **Watchdog de inatividade** (60 s sem progresso → aborta e tenta de novo; 120 s à espera da resposta após enviar tudo) | Fim das conexões zumbi penduradas. |
| **Retentativa automática** (até 3 tentativas, 2 s/6 s ±20 %) só para erros recuperáveis (rede, 5xx, token rejeitado, travamento, tamanho divergente) | Sem retentar "arquivo grande demais", cota, permissão, 413, cancelamento. |
| **Fila com 3 envios simultâneos** (era ilimitado) | Menos disputa de banda/RAM no navegador; falha de um arquivo não derruba os outros. |
| **UI**: %, transferido/total, **velocidade real MB/s** (janela deslizante de 8 s), **tempo restante**, tentativa N/M, total agregado, erros persistentes por arquivo, aviso ao fechar a aba (`beforeunload`) | Visibilidade real; o erro específico não é mais escondido. |
| **Mensagens específicas** pt-BR/en | 404 de token; limite do node (com o valor de MB); 413 de proxy; disco cheio; 5xx; conexão perdida; divergência de tamanho; sem permissão para substituir; etc. |

**Limites honestos desta PR:**
* **Não há retomada**: uma retentativa recomeça do byte 0 (o Wings não aceita offset).
* **Não há paralelismo dentro de um mesmo arquivo** (o que ajudaria em links com perda): exige suporte no Wings (§6). Não foi simulado só no frontend.
* **Integridade = tamanho**, não hash. SHA-256 exige suporte do Wings (§6). Calcular hash no navegador de arquivos de 10 GiB não é viável (a Web Crypto não faz hash incremental).
* **10 GiB**: o painel não impõe teto além de `upload_size >= 1`; o teto real é `api.upload_limit` no `config.yml` do node + cota do servidor. Para 10 GiB: `upload_size = 10240` no node (admin) **e** `api.upload_limit: 10240` no `config.yml` (reiniciar o Wings). Em links de ~0,4–0,6 MB/s, 10 GiB levaria **horas** e **cada falha recomeça do zero** — por isso a retomada (§6) é a melhoria que realmente viabiliza esse tamanho.

## 6. Mudanças necessárias no Wings (não implementadas)

Ver [WINGS-RESUMABLE-UPLOADS.md](./WINGS-RESUMABLE-UPLOADS.md).

## 7. Testes

* `yarn test`: 27 testes novos em `resources/scripts/components/server/files/upload/upload.test.ts` (formatação, estimador de velocidade, classificação de erros, fila, watchdog, e o fluxo completo com dependências simuladas: nome temporário, token novo por tentativa, sem retentar erros fatais, tamanho divergente, substituição, rename silencioso, fallback direto, nome >255 bytes, cancelamento, conexão travada).
* `tsc --noEmit` limpo; eslint limpo nos arquivos alterados.
* **Pendente/Não medido:** não houve benchmark de ganho de velocidade. As melhorias desta PR são de **confiabilidade**, não de banda: uma conexão TCP com perda continua limitada ao mesmo ~0,3–0,6 MB/s. Use `scripts/upload-benchmark.mjs` num servidor de **homologação** para medir antes/depois; nenhum número dele foi usado neste documento.
* Pré-existente (não causado por esta PR): `resources/scripts/i18n/uiTranslations.spec.ts` já falha no `master` (13 frases do Workshop e `Total:` de `ServerDetailsBlock` sem entrada no catálogo).

## 8. Implantação

1. Revisar/aprovar a PR e fazer merge em `master`.
2. Build e deploy do **painel** pelo fluxo habitual (`yarn build:production` / `.github/workflows/deploy.yaml`). **Não requer** migração, mudança de `.env`, restart do Wings ou do node.
3. Os usuários precisam de *hard refresh* (cache dos assets).
4. **Verificação pós-deploy** (servidor de teste): enviar um arquivo de ~200 MB; confirmar que aparece `<nome>.<id>.part` durante o envio e que só o nome final existe ao concluir; cancelar um envio e confirmar que o temporário some; enviar de novo o mesmo nome (substituição).
5. **Reversão:** `git revert` do commit e novo deploy do painel; nada a desfazer no node.
6. Para aceitar 10 GiB: ajustar `upload_size` (admin) e `api.upload_limit` (`/etc/pterodactyl/config.yml`, **requer root e reinício do Wings** — fora de horário de pico; containers de jogo continuam rodando, mas WebSocket/SFTP reconectam).

## 9. Diagnóstico manual (somente leitura)

```bash
# no node (ajuste o UUID do servidor)
UUID=26df09e1-519e-431c-9aca-947c80cf0480
wings version
systemctl is-active wings nginx cloudflared
ss -ltnp | grep -E ':(8443|2022)\b'
# erros de upload (tokens ocultos)
grep -a 'upload/file' /var/log/pterodactyl/wings.log | sed -E 's/token=[A-Za-z0-9._-]+/token=REDACTED/g' | tail -50
# conexões ativas e retransmissões
ss -tin state established '( sport = :8443 )'
# arquivo incompleto: dono root + tamanho crescendo (completos são do usuário do servidor)
ls -la --time-style=full-iso /var/lib/pterodactyl/volumes/$UUID/<diretorio>
find /var/lib/pterodactyl/volumes/$UUID -xdev -type f -user root
# (root) upload gravando em inode apagado?
ls -l /proc/$(pgrep -x wings)/fd | grep deleted
# (root) logs detalhados: em /etc/pterodactyl/config.yml, "debug: true" e reiniciar o Wings, para ver os 404 de token
```
No navegador: DevTools → Network → filtrar `upload/file`; salvar HAR. Procure **duas** requisições `upload/file` com o mesmo `token=` (reenvio) ou um `404` com o corpo `{"error":"The requested resource was not found on this server."}`.

---

## English summary

**Root cause.** The error text comes from **Wings**, not from a missing file: it is the 404 Wings returns when the one-time upload token was already used / revoked / lacks scope. Wings (v1.13.4) also writes uploads straight to the final path with `O_TRUNC`, only `chown`s at the end, and on any error removes the file **by path**, so overlapping attempts for the same name can delete each other's data. Measured on node1: ~0.35–0.6 MB/s on a lossy ~130 ms path with heavy retransmissions; the node itself (36 CPUs, ~208 GB free RAM, NVMe) was idle. All six logged Wings upload errors were client-side cancellations. That a replayed token caused the 404, and that data was being written to an unlinked inode, are **hypotheses** (commands above confirm/deny them).

**Fix (panel only, existing endpoints, no Wings/production change).** Fresh token per attempt; upload to a unique temporary name then rename; size verification before and after rename; stall watchdog; automatic retries for recoverable errors only; max 3 parallel files; real MB/s, %, transferred, ETA, attempt counter; specific pt-BR/en errors; `beforeunload` warning. No resume and no intra-file parallelism (needs Wings, see `WINGS-RESUMABLE-UPLOADS.md`); integrity is size-based, not hash-based.

**Deploy.** Merge → normal panel build/deploy; no migration, no Wings restart. Roll back by reverting. For 10 GiB set both the node `upload_size` and `api.upload_limit` in `config.yml` (root + Wings restart).
