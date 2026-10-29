// Operação local para testes. A conexão entre dispositivos exige Firebase com autenticação e regras.
let api;
let selectedOrderId = null;
let orderFilter = 'open';
let kitchenFilter = 'active';
let orderDraft = {};
let menuSearch = '';
let menuCategory = '';
let orderPayment = 'Dinheiro';
let reportFrom = '';
let reportTo = '';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sum = (arr, fn) => arr.reduce((n, row) => n + fn(row), 0);
const dateText = value => new Date(value).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});
const localDate = value => {const d = new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};
const pill = (text,kind='neutral') => `<span class="state-pill ${kind}">${esc(text)}</span>`;
const batchStatus = {new:['Novo','waiting'],preparing:['Em preparo','progress'],ready:['Pronto','success'],delivered:['Entregue','neutral']};
function db(){return api.getDb()}
function orders(){return db().orders || []}
function orderTotal(order){return sum(order.batches||[], b => sum(b.items || [],i=>i.qty*i.unitPrice))}
function orderQty(order){return sum(order.batches||[], b => sum(b.items || [],i=>i.qty))}
function save(){api.saveDb();api.renderAll()}
function todayIso(){return localDate(new Date())}
function orderLabel(o){return o?.customer || (o?.table ? `Mesa ${o.table}` : `Comanda #${o?.number||''}`)}
function openOrderDialog(){const form=document.getElementById('orderForm'),dialog=document.getElementById('orderDialog');form?.reset();if(dialog&&!dialog.open){dialog.showModal();setTimeout(()=>document.getElementById('orderCustomer')?.focus(),0)}}
function dismissOrderDialog(){document.getElementById('orderForm')?.reset();const dialog=document.getElementById('orderDialog');if(dialog?.open)dialog.close()}
function inRange(value,from=reportFrom,to=reportTo){const day=localDate(value);return (!from||day>=from)&&(!to||day<=to)}
export function initOperations(apiRef){
  api=apiRef;
  reconcileExistingOrderSales();
  document.getElementById('newOrderBtn').addEventListener('click',openOrderDialog);
  document.getElementById('orderForm').addEventListener('submit',createOrder);
  document.getElementById('closeOrderDialog').addEventListener('click',dismissOrderDialog);
  document.getElementById('cancelOrderDialog').addEventListener('click',dismissOrderDialog);
  document.getElementById('orderDialog').addEventListener('cancel',()=>{document.getElementById('orderForm').reset()});
  document.getElementById('orderSearch').addEventListener('input',()=>renderOrders());
  document.getElementById('orderFilters').addEventListener('click',e=>{const b=e.target.closest('[data-order-filter]');if(!b)return;orderFilter=b.dataset.orderFilter;renderOrders()});
  document.getElementById('kitchenFilters').addEventListener('click',e=>{const b=e.target.closest('[data-kitchen-filter]');if(!b)return;kitchenFilter=b.dataset.kitchenFilter;renderKitchen()});
  document.getElementById('ordersList').addEventListener('click',e=>{const del=e.target.closest('[data-delete-order-card]');if(del){e.preventDefault();e.stopPropagation();deleteOrder(del.dataset.deleteOrderCard);return}const b=e.target.closest('[data-select-order]');if(!b)return;selectedOrderId=b.dataset.selectOrder;orderDraft={};menuSearch='';menuCategory='';orderPayment='Dinheiro';renderOrders()});
  document.getElementById('orderDetail').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.orderPayment){orderPayment=b.dataset.orderPayment;renderOrderPaymentState();return}
    if(b.dataset.draftAdd)updateDraft(b.dataset.draftAdd,1);
    if(b.dataset.draftRemove)updateDraft(b.dataset.draftRemove,-1);
    if(b.dataset.draftClear)updateDraft(b.dataset.draftClear,-(orderDraft[b.dataset.draftClear]||0));
    if(b.id==='sendOrderBtn')sendOrder();
    if(b.id==='closeOrderBtn')closeOrder();
    if(b.id==='deleteOrderBtn')deleteOrder();
    if(b.id==='backOrdersBtn'){selectedOrderId=null;orderDraft={};orderPayment='Dinheiro';renderOrders()}
  });
  document.getElementById('kitchenBoard').addEventListener('click',e=>{const b=e.target.closest('[data-kitchen-status]');if(b)updateKitchenStatus(b.dataset.batchId,b.dataset.kitchenStatus)});
  document.getElementById('dashboardRecent').addEventListener('click',e=>{const b=e.target.closest('[data-dashboard-order]');if(!b)return;selectedOrderId=b.dataset.dashboardOrder;orderFilter='open';api.setView('comandas')});
  document.getElementById('dashboardNewOrder').addEventListener('click',openOrderDialog);
  document.getElementById('dashboardGoOrders').addEventListener('click',()=>api.setView('comandas'));
  document.getElementById('reportsFrom').addEventListener('change',e=>{reportFrom=e.target.value;if(reportFrom&&reportTo&&reportFrom>reportTo)reportTo=reportFrom;syncReportRange();renderReports()});
  document.getElementById('reportsTo').addEventListener('change',e=>{reportTo=e.target.value;if(reportFrom&&reportTo&&reportTo<reportFrom)reportFrom=reportTo;syncReportRange();renderReports()});
  document.getElementById('reportsReset').addEventListener('click',()=>{reportFrom='';reportTo='';syncReportRange();renderReports()});
  document.getElementById('exportSalesBtn').addEventListener('click',exportSales);
}
function createOrder(e){
  e.preventDefault();
  const customer=document.getElementById('orderCustomer').value.trim().slice(0,80);
  const table=document.getElementById('orderTable').value.trim().slice(0,40);
  const waiter=document.getElementById('orderWaiter').value.trim().slice(0,80);
  const d=db();
  const order={id:api.uid('cmd'),number:String((d.orderCounter || 1000)+1),customer,table,waiter,createdAt:new Date().toISOString(),status:'open',batches:[]};
  d.orderCounter=Number(order.number);d.orders.unshift(order);
  selectedOrderId=order.id;orderFilter='open';orderDraft={};orderPayment='Dinheiro';
  dismissOrderDialog();save();
  api.setView('comandas');api.toast(`Comanda #${order.number} aberta.`)
}
function selectedOrder(){return orders().find(o=>o.id===selectedOrderId)}
function updateDraft(id,delta){
  const order=selectedOrder(),p=db().products.find(x=>x.id===id);
  if(!order||order.status!=='open'||!p)return;
  const newQty=Math.max(0,(orderDraft[id]||0)+delta);
  // Estoque é debitado ao enviar o pedido, não ao abrir a comanda.
  if(delta>0&&p.trackStock&&newQty>Number(p.stock)){api.toast('Estoque insuficiente para esse produto.');return}
  if(newQty)orderDraft[id]=newQty;else delete orderDraft[id];
  // Keep the catalog DOM (and its scroll position) intact when quantities change.
  updateDraftDisplay();
}
function draftItems(){return Object.entries(orderDraft).map(([id,qty])=>({product:db().products.find(p=>p.id===id),qty})).filter(i=>i.product&&i.qty>0)}
function updateDraftDisplay(){
  const root=document.getElementById('orderDetail'),list=root.querySelector('#draftSummaryList');
  if(!list)return;
  const pageX=window.scrollX,pageY=window.scrollY,summaryTop=list.scrollTop;
  const active=document.activeElement;
  const focusAction=active?.closest('#draftSummaryList')?['draftAdd','draftRemove','draftClear'].find(k=>active.dataset[k]):null;
  const focusId=focusAction?active.dataset[focusAction]:null;
  const items=draftItems(),qty=sum(items,i=>i.qty),total=sum(items,i=>i.qty*Number(i.product.price));
  root.querySelectorAll('.order-menu .menu-item').forEach(row=>{
    const add=row.querySelector('[data-draft-add]'),remove=row.querySelector('[data-draft-remove]');
    const p=db().products.find(p=>p.id===add.dataset.draftAdd),count=orderDraft[p.id]||0;
    row.querySelector('.qty-actions b').textContent=count;
    remove.disabled=!count;add.disabled=Boolean(p.trackStock&&count>=Number(p.stock));
  });
  list.innerHTML=items.length?items.map(({product:p,qty})=>`<div class="draft-summary-item"><div class="draft-summary-product"><strong>${esc(p.name)}</strong><small>${qty} × ${api.money(p.price)} · Subtotal <b>${api.money(qty*p.price)}</b></small></div><div class="qty-actions draft-summary-actions"><button type="button" data-draft-remove="${esc(p.id)}" aria-label="Diminuir ${esc(p.name)} no resumo">−</button><b>${qty}</b><button type="button" data-draft-add="${esc(p.id)}" ${p.trackStock&&qty>=Number(p.stock)?'disabled':''} aria-label="Adicionar ${esc(p.name)} no resumo">+</button><button type="button" class="draft-remove-item" data-draft-clear="${esc(p.id)}" aria-label="Remover ${esc(p.name)} do resumo">×</button></div></div>`).join(''):'<p class="draft-empty">Nenhum item selecionado. Escolha os produtos acima.</p>';
  root.querySelector('#draftSummaryCount').textContent=`${qty} ${qty===1?'item':'itens'}`;
  root.querySelector('#draftTotal').textContent=api.money(total);
  root.querySelector('#sendOrderBtn').disabled=!items.length;
  if(focusAction){const next=[...list.querySelectorAll('button')].find(b=>b.dataset[focusAction]===focusId);(next||root.querySelector('#draftSummaryTitle')).focus({preventScroll:true});}
  list.scrollTop=summaryTop;
  window.scrollTo(pageX,pageY);
}
function sendOrder(){
  const o=selectedOrder();if(!o||o.status!=='open')return;
  const d=db(),items=Object.entries(orderDraft).map(([id,qty])=>{const p=d.products.find(x=>x.id===id);return p?{productId:id,name:p.name,qty,unitPrice:Number(p.price),unitCost:Number(p.cost),area:p.area||(/bebida|cerveja|drink|refrigerante|água/i.test(p.category)?'Bar':'Cozinha')}:null}).filter(Boolean);
  if(!items.length){api.toast('Escolha pelo menos um produto.');return}
  for(const i of items){const p=d.products.find(x=>x.id===i.productId);if(p.trackStock&&p.stock<i.qty){api.toast(`Estoque insuficiente: ${i.name}`);return}}
  const now=new Date().toISOString();
  items.forEach(i=>{const p=d.products.find(x=>x.id===i.productId);if(p.trackStock)p.stock-=i.qty});
  o.batches.push({id:api.uid('lot'),items,status:'new',createdAt:now});
  orderDraft={};save();api.toast('Pedido enviado para o painel da cozinha.');
}
function reconcileExistingOrderSales(){
  let changed=false;
  for(const o of orders()){
    if(o.financialDeletedAt)continue;
    const hasSale=(o.saleId&&db().sales.some(s=>s.id===o.saleId))||db().sales.some(s=>s.source==='comanda'&&s.orderId===o.id);
    if(hasSale)continue;
    if(o.status==='closed'&&(o.batches||[]).length){syncOrderFinancialSale(o,{includeAll:true,finalize:true,payment:o.payment||'Não informado'});changed=true}
    else if(o.status==='open'&&(o.batches||[]).some(b=>b.status==='delivered')){syncOrderFinancialSale(o,{includeAll:false,finalize:false});changed=true}
  }
  if(changed)api.saveDb();
}
function orderSaleItems(o,includeAll=false){return (o.batches||[]).filter(b=>includeAll||b.status==='delivered').flatMap(b=>b.items.map(i=>({productId:i.productId,name:i.name,immediateQty:i.qty,tokenQty:0,qty:i.qty,unitPrice:Number(i.unitPrice||0),unitCost:Number(i.unitCost||0),batchId:b.id})))}
function syncOrderFinancialSale(o,{includeAll=false,finalize=false,payment=null}={}){
  if(o.financialDeletedAt)return null;
  const items=orderSaleItems(o,includeAll);if(!items.length)return null;
  const d=db(),now=new Date().toISOString();
  let sale=(o.saleId&&d.sales.find(s=>s.id===o.saleId))||d.sales.find(s=>s.source==='comanda'&&s.orderId===o.id);
  if(!sale){sale={id:api.uid('v'),number:o.number,createdAt:now,source:'comanda',orderId:o.id,customer:o.customer,table:o.table,waiter:o.waiter};d.sales.unshift(sale);o.saleId=sale.id}
  Object.assign(sale,{customer:o.customer,table:o.table,waiter:o.waiter,items,total:sum(items,i=>i.qty*i.unitPrice),cost:sum(items,i=>i.qty*i.unitCost),tokenCount:0,immediateCount:sum(items,i=>i.qty),deliveredBatchIds:[...new Set(items.map(i=>i.batchId))],updatedAt:now});
  if(finalize){sale.payment=payment||o.payment||'Não informado';sale.financialStatus='finalized';sale.receivedAt=now}else{sale.payment='Pendente';sale.financialStatus='pending'}
  return sale
}
function closeOrder(){
  const o=selectedOrder();if(!o||o.status!=='open')return;
  if(!o.batches.length){api.toast('Envie pelo menos um pedido antes de fechar.');return}
  if(o.batches.some(b=>b.status!=='delivered')&&!confirm('Há itens ainda não marcados como entregues. Deseja fechar a comanda mesmo assim?'))return;
  if(o.financialDeletedAt){if(!confirm('O lançamento anterior foi excluído. Fechar e receber criará uma nova venda com todos os itens. Continuar?'))return;delete o.financialDeletedAt;}
  const payment=orderPayment,now=new Date().toISOString();
  o.status='closed';o.closedAt=now;o.payment=payment;
  syncOrderFinancialSale(o,{includeAll:true,finalize:true,payment});orderDraft={};save();api.toast(`Comanda #${o.number} fechada. Financeiro atualizado sem duplicar a venda.`)
}
function deleteOrder(orderId=selectedOrderId){
  const o=orders().find(x=>x.id===orderId);if(!o)return;
  const d=db(),linkedSales=d.sales.filter(s=>(o.saleId&&s.id===o.saleId)||(s.source==='comanda'&&s.orderId===o.id));
  const qty=orderQty(o),parts=[];
  if(qty)parts.push(`${qty} item(ns) lançado(s) também sairão da cozinha/histórico da comanda.`);
  if(linkedSales.length)parts.push('O lançamento financeiro vinculado também será removido.');
  if(qty)parts.push('O estoque NÃO será devolvido automaticamente; se necessário, faça um ajuste de estoque depois.');
  if(!qty&&!linkedSales.length)parts.push('A comanda sairá das abertas sem gerar venda, lançamento financeiro ou histórico e sem alterar o estoque.');
  const detail=parts.length?`\n\n${parts.join('\n')}`:'';
  if(!confirm(`${o.status==='open'?'Cancelar':'Excluir'} a comanda #${o.number}${o.customer?` de ${o.customer}`:''}?${detail}`))return;
  d.sales=d.sales.filter(s=>!((o.saleId&&s.id===o.saleId)||(s.source==='comanda'&&s.orderId===o.id)));
  d.orders=d.orders.filter(x=>x.id!==o.id);
  if(selectedOrderId===o.id){selectedOrderId=null;orderDraft={};menuSearch='';menuCategory='';orderPayment='Dinheiro'}
  save();
  api.toast(`Comanda #${o.number} excluída.`)
}
function updateKitchenStatus(batchId,next){
  const allowed={new:'preparing',preparing:'ready',ready:'delivered'};
  const o=orders().find(x=>x.batches.some(b=>b.id===batchId));
  const b=o?.batches.find(x=>x.id===batchId);
  if(!b||allowed[b.status]!==next)return;
  const now=new Date().toISOString();b.status=next;b[`${next}At`]=now;
  if(next==='delivered')syncOrderFinancialSale(o,{includeAll:o.status==='closed',finalize:o.status==='closed',payment:o.payment});
  save();api.toast(next==='delivered'?'Pedido entregue e lançado no financeiro.':'Etapa atualizada.')
}
export function renderOperations(){if(!api)return;renderDashboard();renderOrders();renderKitchen();renderReports()}
function renderDashboard(){
  const d=db(),salesToday=d.sales.filter(s=>localDate(s.createdAt)===todayIso());
  const active=orders().filter(o=>o.status==='open');
  const pending=orders().flatMap(o=>o.batches.filter(b=>!['ready','delivered'].includes(b.status)));
  const low=d.products.filter(p=>p.trackStock&&Number(p.stock)<=Number(p.minStock)).length;
  const cards=[['Vendas de hoje',api.money(sum(salesToday,s=>Number(s.total||0))),'blue','Entradas de balcão e comandas'],['Comandas abertas',active.length,'cyan','Aguardando fechamento'],['Pedidos na cozinha',pending.length,'gold','Novos ou em preparo'],['Estoque baixo',low,'rose','Itens que precisam de atenção']];
  document.getElementById('dashboardStats').innerHTML=cards.map(([label,val,color,hint])=>`<article class="metric-card metric-${color}"><span class="metric-label">${label}</span><strong>${val}</strong><small>${hint}</small></article>`).join('');
  document.getElementById('dashboardRecent').innerHTML=active.length?active.slice(0,6).map(o=>`<button class="recent-order" data-dashboard-order="${esc(o.id)}"><span class="recent-avatar">#${esc(o.number).slice(-2)}</span><span><strong>${esc(orderLabel(o))}</strong><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Atendimento')} · ${orderQty(o)} itens</small></span><b>${api.money(orderTotal(o))}</b><span aria-hidden="true">›</span></button>`).join(''):'<div class="illustrated-empty">Nenhuma comanda aberta agora. Abra uma comanda para começar o atendimento.</div>';
  const recentSales=[...d.sales].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
  document.getElementById('dashboardSales').innerHTML=recentSales.length?recentSales.map(s=>`<div class="dash-sale"><span>${esc(s.customer||'Balcão')} <small>· ${dateText(s.createdAt)}</small></span><b>${api.money(s.total)}</b></div>`).join(''):'<div class="illustrated-empty">As vendas aparecerão aqui assim que forem concluídas.</div>';
}
function renderOrders(){
  if(selectedOrderId&&!selectedOrder()){selectedOrderId=null;orderDraft={};}
  document.querySelectorAll('#orderFilters [data-order-filter]').forEach(b=>b.classList.toggle('active',b.dataset.orderFilter===orderFilter));
  const q=(document.getElementById('orderSearch')?.value||'').toLowerCase().trim();
  const list=orders().filter(o=>(orderFilter==='all'||o.status===orderFilter)&&(!q||[o.customer,o.table,o.waiter,o.number].some(v=>String(v||'').toLowerCase().includes(q))));
  document.getElementById('ordersCount').textContent=`${list.length} comanda${list.length===1?'':'s'}`;
  document.querySelector('.orders-layout')?.classList.toggle('has-selection',Boolean(selectedOrderId));
  document.getElementById('ordersList').innerHTML=list.length?list.map(o=>`<article class="order-card ${o.id===selectedOrderId?'selected':''}"><button type="button" class="order-card-main" data-select-order="${esc(o.id)}"><div class="order-card-top"><span class="order-num">#${esc(o.number)}</span>${pill(o.status==='open'?'Aberta':'Fechada',o.status==='open'?'progress':'neutral')}</div><strong>${esc(orderLabel(o))}</strong><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Sem garçom')} • ${dateText(o.createdAt)}</small><div class="order-card-bottom"><span>${orderQty(o)} itens</span><b>${api.money(orderTotal(o))}</b></div></button><button type="button" class="order-card-delete" data-delete-order-card="${esc(o.id)}" aria-label="Excluir comanda #${esc(o.number)}"><span aria-hidden="true">⌫</span> Excluir</button></article>`).join(''):'<div class="illustrated-empty">Nenhuma comanda encontrada nesse filtro.</div>';
  renderOrderDetail()
}
function paymentButtons(selected=orderPayment){
  const options=[['Dinheiro','R$','Espécie'],['PIX','◆','Instantâneo'],['Débito','▣','Cartão'],['Crédito','▤','Cartão']];
  return options.map(([value,icon,hint])=>`<button type="button" class="payment-option ${selected===value?'active':''}" data-order-payment="${esc(value)}" aria-pressed="${selected===value?'true':'false'}"><span class="payment-icon ${value==='Dinheiro'?'payment-icon-money':''}" aria-hidden="true">${icon}</span><span><strong>${value}</strong><small>${hint}</small></span></button>`).join('')
}
function renderOrderPaymentState(){
  const root=document.getElementById('orderDetail');
  root?.querySelectorAll('[data-order-payment]').forEach(btn=>{const active=btn.dataset.orderPayment===orderPayment;btn.classList.toggle('active',active);btn.setAttribute('aria-pressed',String(active))})
}
function syncReportRange(){const from=document.getElementById('reportsFrom'),to=document.getElementById('reportsTo');if(!from||!to)return;from.value=reportFrom;to.value=reportTo;to.min=reportFrom||'';from.max=reportTo||''}
function renderOrderDetail(){
  const o=selectedOrder(),el=document.getElementById('orderDetail');
  if(!o){el.innerHTML='<div class="order-placeholder"><span class="placeholder-icon">☰</span><h3>Atendimento por comanda</h3><p>Selecione uma comanda à esquerda ou abra uma nova para começar a lançar os pedidos pelo celular.</p></div>';return}
  const editable=o.status==='open',d=db(),cats=[...new Set(d.products.map(p=>p.category))].sort();
  const batches=(o.batches||[]).slice().reverse().map(b=>`<div class="order-batch"><div class="batch-meta"><span>${dateText(b.createdAt)}</span>${pill(batchStatus[b.status]?.[0]||b.status,batchStatus[b.status]?.[1])}</div>${b.items.map(i=>`<div class="batch-item"><span>${i.qty}× ${esc(i.name)}</span><strong>${api.money(i.unitPrice*i.qty)}</strong></div>`).join('')}</div>`).join('');
  const products=d.products.filter(p=>(!menuSearch||p.name.toLowerCase().includes(menuSearch))&&(!menuCategory||p.category===menuCategory));
  const draftTotal=sum(Object.entries(orderDraft),([id,qty])=>qty*(d.products.find(p=>p.id===id)?.price||0));
  el.innerHTML=`<div class="order-detail-head"><div><button class="back-orders" id="backOrdersBtn">← Voltar às comandas</button><span class="mini-label">${o.status==='open'?'Atendimento em andamento':'Venda concluída'}</span><h2>${esc(o.customer || (o.table ? `Mesa ${o.table}` : 'Comanda'))} <span>#${esc(o.number)}</span></h2><p>${esc([o.table?`Mesa ${o.table}`:'',o.waiter?`Garçom: ${o.waiter}`:'',`Aberta: ${dateText(o.createdAt)}`].filter(Boolean).join(' · '))}</p></div><div class="order-head-actions">${pill(o.status==='open'?'Aberta':'Fechada',o.status==='open'?'progress':'neutral')}<button type="button" class="danger-outline" id="deleteOrderBtn" ${editable?'aria-label="Cancelar comanda"':'aria-label="Excluir comanda"'}>${editable?'Cancelar comanda':'Excluir comanda'}</button></div></div>
  ${editable?`<div class="order-composer"><div class="subsection-heading"><h3>Adicionar produtos</h3><small>Itens só entram na conta após o envio</small></div><div class="menu-filter"><input aria-label="Buscar no cardápio" id="orderProductSearch" placeholder="Buscar no cardápio..." value="${esc(menuSearch)}"><select aria-label="Filtrar categoria" id="orderProductCategory"><option value="">Todas as categorias</option>${cats.map(c=>`<option value="${esc(c)}" ${c===menuCategory?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="order-menu">${products.length?products.map(p=>`<div class="menu-item"><span><strong>${esc(p.name)}</strong><small>${esc(p.category)} · ${api.money(p.price)}${p.trackStock?` · ${p.stock} em estoque`:''}</small></span><div class="qty-actions"><button type="button" data-draft-remove="${esc(p.id)}" ${!orderDraft[p.id]?'disabled':''} aria-label="Diminuir ${esc(p.name)}">−</button><b>${orderDraft[p.id]||0}</b><button type="button" data-draft-add="${esc(p.id)}" ${p.trackStock&&p.stock<=(orderDraft[p.id]||0)?'disabled':''} aria-label="Adicionar ${esc(p.name)}">+</button></div></div>`).join(''):'<div class="illustrated-empty">Cadastre produtos ou ajuste sua busca para lançar pedidos.</div>'}</div><section class="draft-summary" aria-labelledby="draftSummaryTitle"><div class="draft-summary-head"><h3 id="draftSummaryTitle" tabindex="-1">Itens selecionados</h3><span id="draftSummaryCount" class="draft-summary-count" aria-live="polite">0 itens</span></div><div id="draftSummaryList" class="draft-summary-list"></div></section><div class="send-bar"><div><small>Total dos novos itens</small><b id="draftTotal">${api.money(draftTotal)}</b></div><button class="primary" id="sendOrderBtn" ${!Object.keys(orderDraft).length?'disabled':''}>Enviar pedido à cozinha →</button></div></div>`:''}
  <div class="order-history"><div class="subsection-heading"><h3>Pedidos lançados</h3><small>${o.batches.length} envio(s)</small></div>${batches||'<div class="illustrated-empty">Nenhum pedido enviado nesta comanda.</div>'}</div>
  <div class="order-checkout"><div class="checkout-total"><span>Total da comanda</span><strong>${api.money(orderTotal(o))}</strong></div>${editable?`<div class="checkout-action checkout-action-modern"><div class="checkout-payment"><div class="payment-title"><span>Forma de pagamento</span><small>Selecione antes de finalizar</small></div><div class="payment-options compact" role="radiogroup" aria-label="Forma de pagamento da comanda">${paymentButtons(orderPayment)}</div></div><button class="primary close-order-button" id="closeOrderBtn" ${!o.batches.length?'disabled':''}>Fechar e receber</button></div>`:`<p>Fechada em ${dateText(o.closedAt)} · ${esc(o.payment||'Pagamento não informado')}</p>`}</div>`;
  if(editable)updateDraftDisplay();
  // Campos gerados dinamicamente usam delegação para preservar os eventos do celular.
  el.querySelector('#orderProductSearch')?.addEventListener('input',e=>{const pos=e.target.selectionStart;menuSearch=e.target.value.toLowerCase();renderOrderDetail();const input=el.querySelector('#orderProductSearch');if(input){input.focus();input.setSelectionRange(pos,pos)}});
  el.querySelector('#orderProductCategory')?.addEventListener('change',e=>{menuCategory=e.target.value;renderOrderDetail()});
}
function renderKitchen(){
  document.querySelectorAll('#kitchenFilters [data-kitchen-filter]').forEach(b=>b.classList.toggle('active',b.dataset.kitchenFilter===kitchenFilter));
  const entries=orders().flatMap(o=>(o.batches||[]).map(b=>({o,b}))).sort((a,b)=>a.b.createdAt.localeCompare(b.b.createdAt));
  const filtered=entries.filter(({b})=>kitchenFilter==='all'||(kitchenFilter==='active'?['new','preparing','ready'].includes(b.status):b.status===kitchenFilter));
  const next={new:['Iniciar preparo','preparing'],preparing:['Marcar como pronto','ready'],ready:['Marcar entregue','delivered']};
  document.getElementById('kitchenCount').textContent=`${filtered.length} pedido${filtered.length===1?'':'s'}`;
  document.getElementById('kitchenBoard').innerHTML=filtered.length?filtered.map(({o,b})=>`<article class="kitchen-ticket status-${b.status}"><div class="kitchen-ticket-head"><span class="order-num">#${esc(o.number)}</span>${pill(batchStatus[b.status]?.[0]||b.status,batchStatus[b.status]?.[1])}</div><h3>${esc(orderLabel(o))}</h3><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Balcão')} · ${dateText(b.createdAt)}</small><div class="ticket-lines">${b.items.map(i=>`<div><b>${i.qty}×</b><span>${esc(i.name)} <small>· ${esc(i.area)}</small></span></div>`).join('')}</div>${next[b.status]?`<button class="secondary kitchen-next" data-batch-id="${esc(b.id)}" data-kitchen-status="${next[b.status][1]}">${next[b.status][0]} →</button>`:'<div class="ticket-finished">✓ Entregue</div>'}</article>`).join(''):'<div class="illustrated-empty full-width">Nenhum pedido nesta etapa. Novos pedidos aparecem assim que o garçom envia a comanda.</div>';
}
function renderReports(){
  syncReportRange();
  const sales=db().sales.filter(s=>inRange(s.createdAt)),turnover=sum(sales,s=>Number(s.total||0)),cost=sum(sales,s=>Number(s.cost||0));
  const items=new Map(),byDay=new Map();
  for(const sale of sales){
    const date=localDate(sale.createdAt);byDay.set(date,(byDay.get(date)||0)+Number(sale.total||0));
    for(const i of sale.items||[]){const prev=items.get(i.name)||{qty:0,total:0};prev.qty+=i.qty||i.immediateQty||0;prev.total+=(i.qty||i.immediateQty||0)*i.unitPrice;items.set(i.name,prev)}
  }
  document.getElementById('reportStats').innerHTML=`<article class="metric-card metric-blue"><span class="metric-label">Faturamento</span><strong>${api.money(turnover)}</strong><small>${sales.length} vendas no período</small></article><article class="metric-card metric-cyan"><span class="metric-label">Ticket médio</span><strong>${api.money(sales.length?turnover/sales.length:0)}</strong><small>Valor médio por venda</small></article><article class="metric-card metric-gold"><span class="metric-label">Lucro bruto</span><strong>${api.money(turnover-cost)}</strong><small>Antes das despesas operacionais</small></article>`;
  const best=[...items.entries()].sort((a,b)=>b[1].qty-a[1].qty).slice(0,8),max=Math.max(1,...best.map(x=>x[1].qty));
  document.getElementById('topProducts').innerHTML=best.length?best.map(([name,val])=>`<div class="ranked-item"><span class="ranked-name">${esc(name)} <small>${val.qty} unidades</small></span><div class="rank-bar"><span style="width:${Math.round(val.qty/max*100)}%"></span></div><strong>${api.money(val.total)}</strong></div>`).join(''):'<div class="illustrated-empty">Ainda não há vendas para o período.</div>';
  const days=[...byDay].sort((a,b)=>a[0].localeCompare(b[0])).slice(-14),dayMax=Math.max(1,...days.map(x=>x[1]));
  document.getElementById('dailySales').innerHTML=days.length?days.map(([date,total])=>`<div class="day-bar"><div class="day-value">${api.money(total)}</div><div class="day-column"><span style="height:${Math.max(7,Math.round(total/dayMax*100))}%"></span></div><small>${date.slice(8)}/${date.slice(5,7)}</small></div>`).join(''):'<div class="illustrated-empty">Os resultados diários aparecerão aqui após as primeiras vendas.</div>';
}
function exportSales(){
  const sales=db().sales.filter(s=>inRange(s.createdAt));
  if(!sales.length){api.toast('Sem vendas para exportar nesse período.');return}
  const rows=[['Data','Número','Origem','Cliente','Mesa','Pagamento','Valor (R$)','Custo (R$)','Lucro bruto (R$)'],...sales.map(s=>[dateText(s.createdAt),s.number,s.source==='comanda'?'Comanda':'Balcão',s.customer||'',s.table||'',s.payment,Number(s.total||0).toFixed(2).replace('.',','),Number(s.cost||0).toFixed(2).replace('.',','),(Number(s.total||0)-Number(s.cost||0)).toFixed(2).replace('.',',')])];
  // Prefixos impedem que programas de planilha executem dados de cliente como fórmulas.
  const safe=v=>{const val=String(v??'');const clean=/^[\s]*[=+@\-]/.test(val)&&!/^\d{2}\/\d{2}\/\d{4}/.test(val)?"'"+val:val;return `"${clean.replaceAll('"','""')}"`};
  const csv='\ufeff'+rows.map(row=>row.map(safe).join(';')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`barzinho_vendas_${todayIso()}.csv`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
}


