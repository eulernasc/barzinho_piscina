# Ativação segura: Firebase, usuários e salvamento

Esta branch contém a estrutura do login, gerenciamento de usuários e sincronização com Firestore. Ela não pode ser publicada em produção até completar a configuração abaixo.

## O que foi preparado no código
- Tela de login por e-mail/senha do Firebase Authentication.
- Área Usuários, visível apenas para a conta administradora autorizada.
- Cadastro de equipe, bloqueio e reativação sem trocar a sessão do administrador.
- Consulta dos dados do bar no Firestore somente após autenticação e autorização.
- Regras de acesso exigindo um documento users/{uid} com active=true.
- Dados separados por registro em subcoleções, com revisão transacional.
- Venda, comanda e atualização da cozinha só anunciam sucesso após confirmação no Firestore.
- Falhas no salvamento restauram a última versão confirmada.
- Migração opcional de dados locais existentes no navegador, com confirmação do administrador.

## Configuração necessária, uma única vez
1. Identifique o Firebase correto do Barzinho. Não use a configuração de outro aplicativo por engano.
2. Em Firebase > Configurações do projeto > Seus apps > aplicativo Web, copie a configuração pública para js/firebase-config.js: apiKey, authDomain, projectId, appId etc. Não insira senhas ou chaves de Service Account.
3. Em Authentication, confirme E-mail/senha habilitado e configure eulernasc.github.io como domínio autorizado. Para testes locais, autorize localhost se necessário.
4. Confirme que o Cloud Firestore está criado.
5. Revise e publique o conteúdo de firestore.rules no Firebase correto. Se já houver outras regras, integre os blocos deste app preservando as regras dos outros sistemas.
6. No Firebase Authentication, identifique o UID da sua conta administradora. Crie uma única vez o documento Firestore users/{SEU_UID} com:
   name: seu nome
   email: e-mail cadastrado
   role: admin
   active: true

O app não promove usuários automaticamente. Esse cadastro inicial deve ser seguro e manual.
7. Entre como administrador. A partir daí, novos logins poderão ser criados pelo app.

## Migração de dados antigos
- Guarde backup do localStorage identificado por barzinhoPiscinaDB_v1.
- Abra o aplicativo no navegador que contém os dados reais. Não importe backups divergentes de dispositivos diferentes.
- Na aba Usuários, utilize Importar backup do navegador para o Firebase.
- A importação só funciona com o banco remoto vazio e até 400 registros.
- Os dados locais não são apagados. Se houver mais de 400 registros, é necessário planejar migração em lotes.

## Validação obrigatória antes da publicação
1. Administrador autentica e vê os dados no Firestore.
2. Administrador cadastra equipe, que entra de outro navegador.
3. Usuário não autorizado não tem acesso aos dados.
4. Bloqueio impede leitura e escrita por usuário desativado.
5. Pedidos e comandas aparecem no segundo aparelho após confirmação.
6. Venda só gera confirmação e impressão após gravação remota.
7. Sem conexão, pedido não pode aparecer como enviado à cozinha.
8. Duas alterações simultâneas não podem causar sobrescrita silenciosa.
9. Histórico e estoque permanecem íntegros após migração.

## Limitações conhecidas
- Sem modo offline: gravação de pedido/venda exige resposta do Firestore.
- Se o projeto Firebase tiver impedido criação de usuários pelo SDK Web, será necessária uma Cloud Function autorizada com Admin SDK.
- Um commit GitHub NÃO aplica regras no Firebase, nem cria usuários.
- Falta testar com o Firebase real, pois ainda não há projectId, configuração Web ou UID de admin confirmados nesta conversa.
- Não faça merge em main antes desses testes.
