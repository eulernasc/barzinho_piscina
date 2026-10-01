# Barzinho da Piscina

Sistema de controle do bar da Praça de Esportes.

## Primeira versão

Já implementado:

- PDV de balcão
- carrinho de produtos
- venda imediata ou emissão de fichas
- impressão térmica pelo navegador
- cadastro de produtos e pratos
- preço de venda e custo
- estoque e estoque mínimo
- faturamento
- custo das vendas
- lucro bruto e margem
- entradas e saídas manuais
- resumo por forma de pagamento
- histórico de vendas
- layout responsivo

## Banco de dados

Nesta primeira fase os dados ficam no `localStorage` do navegador para permitir teste rápido pelo GitHub Pages sem configuração de backend.

A próxima etapa será migrar o armazenamento para Firebase/Firestore e adicionar autenticação e perfis de acesso.

## Estrutura futura no Firebase

Coleções sugeridas:

- `products`
- `sales`
- `cashMovements`
- `users`
- `settings`

## Impressora térmica

Ao concluir uma venda, o sistema gera um layout de impressão preparado para impressoras térmicas. Quando o modo **Emitir fichas** estiver selecionado, cada unidade comprada gera uma ficha individual do respectivo produto.

Para impressão totalmente automática, sem abrir a janela do navegador, será necessário configurar um serviço local no computador do bar.
