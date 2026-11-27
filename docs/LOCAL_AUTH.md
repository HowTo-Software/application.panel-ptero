# Local authentication / Autenticação local

The login page offers **Legacy login system / Sistema de login antigo** alongside Authentik. Set `LOCAL_AUTH_ENABLED=true` (default) to enable it. Set false to disable local password login and reset endpoints. Rebuild frontend assets and refresh the Laravel config cache during deployment.

In **Admin > Users > Create**, create a non-administrator user with an unused email and username. Leave the password blank to queue a first-access email containing a local password setup link. Alternatively, assign a password and communicate it securely; the email does not contain the password. The account uses the existing panel database, permissions and 2FA. It does not require an Authentik account. Website customers with the known HTS customer/trial external IDs can also request a local password through the legacy recovery screen. Other externally managed accounts and root admins remain SSO-only while SSO is configured. Standalone installs without SSO retain upstream local authentication when enabled.

**Important:** the old undocumented direct password endpoint for privileged accounts is intentionally not a break-glass path while SSO is configured. Check that an administrator can use SSO before deploying. Local and SSO passwords are independent.

Configure the panel's `MAIL_*` settings and ensure its default notification queue is running. Test with a real non-admin account; inspect failed jobs and mail delivery. Do not log reset URLs or credentials. A passing HTTP request does not prove SMTP delivery.

## Português

Em **Admin > Usuários > Criar**, cadastre um cliente sem privilégios administrativos. Deixe a senha vazia para enviar o link de primeiro acesso pela fila de e-mails do próprio painel. Caso prefira, defina uma senha e compartilhe-a por um canal seguro. O botão **Sistema de login antigo** usa o mesmo banco de dados, permissões e 2FA do painel. O Authentik permanece como opção principal. Contas administrativas e de diretório não usam essa alternativa quando SSO está configurado. Senhas locais e SSO são independentes. Confirme o SMTP e a fila de notificações antes de liberar para clientes.
