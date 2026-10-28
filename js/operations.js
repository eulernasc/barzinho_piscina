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
function inRange(value,from=reportFrom,to=reportTo){const day=localDate(value);return (!from||day>=from)&&(!to||day<=to)}
export function initOperations(apiRef){
  api=apiRef;
  document.getElementById('newOrderBtn').addEventListener('click',()=>document.getElementById('orderDialog').showModal());
  document.getElementById('orderForm').addEventListener('submit',createOrder);
  document.getElementById('orderSearch').addEventListener('input',()=>renderOrders());
  document.getElementById('orderFilters').addEventListener('click',e=>{const b=e.target.closest('[data-order-filter]');if(!b)return;orderFilter=b.dataset.orderFilter;renderOrders()});
  document.getElementById('kitchenFilters').addEventListener('click',e=>{const b=e.target.closest('[data-kitchen-filter]');if(!b)return;kitchenFilter=b.dataset.kitchenFilter;renderKitchen()});
  document.getElementById('ordersList').addEventListener('click',e=>{const b=e.target.closest('[data-select-order]');if(!b)return;selectedOrderId=b.dataset.selectOrder;orderDraft={};menuSearch='';menuCategory='';orderPayment='Dinheiro';renderOrders()});
  document.getElementById('orderDetail').addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.orderPayment){orderPayment=b.dataset.orderPayment;renderOrderPaymentState();return}
    if(b.dataset.draftAdd)updateDraft(b.dataset.draftAdd,1);
    if(b.dataset.draftRemove)updateDraft(b.dataset.draftRemove,-1);
    if(b.id==='sendOrderBtn')sendOrder();
    if(b.id==='closeOrderBtn')closeOrder();
    if(b.id==='backOrdersBtn'){selectedOrderId=null;orderDraft={};orderPayment='Dinheiro';renderOrders()}
  });
  document.getElementById('kitchenBoard').addEventListener('click',e=>{const b=e.target.closest('[data-kitchen-status]');if(b)updateKitchenStatus(b.dataset.batchId,b.dataset.kitchenStatus)});
  document.getElementById('dashboardRecent').addEventListener('click',e=>{const b=e.target.closest('[data-dashboard-order]');if(!b)return;selectedOrderId=b.dataset.dashboardOrder;orderFilter='open';api.setView('comandas')});
  document.getElementById('dashboardNewOrder').addEventListener('click',()=>document.getElementById('orderDialog').showModal());
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
  if(!customer&&!table){api.toast('Informe o cliente ou número da mesa.');return}
  const d=db();
  const order={id:api.uid('cmd'),number:String((d.orderCounter || 1000)+1),customer,table,waiter,createdAt:new Date().toISOString(),status:'open',batches:[]};
  d.orderCounter=Number(order.number);d.orders.unshift(order);
  selectedOrderId=order.id;orderFilter='open';orderDraft={};orderPayment='Dinheiro';
  document.getElementById('orderForm').reset();document.getElementById('orderDialog').close();save();
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
  renderOrderDetail()
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
function closeOrder(){
  const o=selectedOrder();if(!o||o.status!=='open')return;
  if(!o.batches.length){api.toast('Envie pelo menos um pedido antes de fechar.');return}
  if(o.batches.some(b=>b.status!=='delivered')&&!confirm('Há itens ainda não marcados como entregues. Deseja fechar a comanda mesmo assim?'))return;
  const payment=orderPayment;
  const items=o.batches.flatMap(b=>b.items.map(i=>({productId:i.productId,name:i.name,immediateQty:i.qty,tokenQty:0,qty:i.qty,unitPrice:i.unitPrice,unitCost:i.unitCost})));
  const now=new Date().toISOString();
  const sale={id:api.uid('v'),number:o.number,createdAt:now,source:'comanda',orderId:o.id,customer:o.customer,table:o.table,waiter:o.waiter,payment,items,total:sum(items,i=>i.qty*i.unitPrice),cost:sum(items,i=>i.qty*i.unitCost),tokenCount:0,immediateCount:sum(items,i=>i.qty)};
  o.status='closed';o.closedAt=now;o.payment=payment;o.saleId=sale.id;
  db().sales.unshift(sale);orderDraft={};save();api.toast(`Comanda #${o.number} fechada. Venda registrada.`)
}
function updateKitchenStatus(batchId,next){
  const allowed={new:'preparing',preparing:'ready',ready:'delivered'};
  const o=orders().find(x=>x.batches.some(b=>b.id===batchId));
  const b=o?.batches.find(x=>x.id===batchId);
  if(!b||allowed[b.status]!==next)return;
  b.status=next;b[`${next}At`]=new Date().toISOString();save();api.toast('Etapa atualizada.')
}
export function renderOperations(){if(!api)return;renderDashboard();renderOrders();renderKitchen();renderReports()}
function renderDashboard(){
  const d=db(),salesToday=d.sales.filter(s=>localDate(s.createdAt)===todayIso());
  const active=orders().filter(o=>o.status==='open');
  const pending=orders().flatMap(o=>o.batches.filter(b=>!['ready','delivered'].includes(b.status)));
  const low=d.products.filter(p=>p.trackStock&&Number(p.stock)<=Number(p.minStock)).length;
  const cards=[['Vendas de hoje',api.money(sum(salesToday,s=>Number(s.total||0))),'blue','Entradas de balcão e comandas'],['Comandas abertas',active.length,'cyan','Aguardando fechamento'],['Pedidos na cozinha',pending.length,'gold','Novos ou em preparo'],['Estoque baixo',low,'rose','Itens que precisam de atenção']];
  document.getElementById('dashboardStats').innerHTML=cards.map(([label,val,color,hint])=>`<article class="metric-card metric-${color}"><span class="metric-label">${label}</span><strong>${val}</strong><small>${hint}</small></article>`).join('');
  document.getElementById('dashboardRecent').innerHTML=active.length?active.slice(0,6).map(o=>`<button class="recent-order" data-dashboard-order="${esc(o.id)}"><span class="recent-avatar">#${esc(o.number).slice(-2)}</span><span><strong>${esc(o.customer||`Mesa ${o.table}`)}</strong><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Atendimento')} · ${orderQty(o)} itens</small></span><b>${api.money(orderTotal(o))}</b><span aria-hidden="true">›</span></button>`).join(''):'<div class="illustrated-empty">Nenhuma comanda aberta agora. Abra uma comanda para começar o atendimento.</div>';
  const recentSales=[...d.sales].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
  document.getElementById('dashboardSales').innerHTML=recentSales.length?recentSales.map(s=>`<div class="dash-sale"><span>${esc(s.customer||'Balcão')} <small>· ${dateText(s.createdAt)}</small></span><b>${api.money(s.total)}</b></div>`).join(''):'<div class="illustrated-empty">As vendas aparecerão aqui assim que forem concluídas.</div>';
}
function renderOrders(){
  document.querySelectorAll('#orderFilters [data-order-filter]').forEach(b=>b.classList.toggle('active',b.dataset.orderFilter===orderFilter));
  const q=(document.getElementById('orderSearch')?.value||'').toLowerCase().trim();
  const list=orders().filter(o=>(orderFilter==='all'||o.status===orderFilter)&&(!q||[o.customer,o.table,o.waiter,o.number].some(v=>String(v||'').toLowerCase().includes(q))));
  document.getElementById('ordersCount').textContent=`${list.length} comanda${list.length===1?'':'s'}`;
  document.querySelector('.orders-layout')?.classList.toggle('has-selection',Boolean(selectedOrderId));
  document.getElementById('ordersList').innerHTML=list.length?list.map(o=>`<button class="order-card ${o.id===selectedOrderId?'selected':''}" data-select-order="${esc(o.id)}"><div class="order-card-top"><span class="order-num">#${esc(o.number)}</span>${pill(o.status==='open'?'Aberta':'Fechada',o.status==='open'?'progress':'neutral')}</div><strong>${esc(o.customer||`Mesa ${o.table}`)}</strong><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Sem garçom')} • ${dateText(o.createdAt)}</small><div class="order-card-bottom"><span>${orderQty(o)} itens</span><b>${api.money(orderTotal(o))}</b></div></button>`).join(''):'<div class="illustrated-empty">Nenhuma comanda encontrada nesse filtro.</div>';
  renderOrderDetail()
}
function paymentButtons(selected=orderPayment){
  const options=[['Dinheiro','$','Espécie'],['PIX','◆','Instantâneo'],['Débito','▣','Cartão'],['Crédito','▤','Cartão']];
  return options.map(([value,icon,hint])=>`<button type="button" class="payment-option ${selected===value?'active':''}" data-order-payment="${esc(value)}" aria-pressed="${selected===value?'true':'false'}"><span class="payment-icon" aria-hidden="true">${icon}</span><span><strong>${value}</strong><small>${hint}</small></span></button>`).join('')
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
  el.innerHTML=`<div class="order-detail-head"><div><button class="back-orders" id="backOrdersBtn">← Voltar às comandas</button><span class="mini-label">${o.status==='open'?'Atendimento em andamento':'Venda concluída'}</span><h2>${esc(o.customer||`Mesa ${o.table}`)} <span>#${esc(o.number)}</span></h2><p>${esc([o.table?`Mesa ${o.table}`:'',o.waiter?`Garçom: ${o.waiter}`:'',`Aberta: ${dateText(o.createdAt)}`].filter(Boolean).join(' · '))}</p></div>${pill(o.status==='open'?'Aberta':'Fechada',o.status==='open'?'progress':'neutral')}</div>
  ${editable?`<div class="order-composer"><div class="subsection-heading"><h3>Adicionar produtos</h3><small>Itens só entram na conta após o envio</small></div><div class="menu-filter"><input aria-label="Buscar no cardápio" id="orderProductSearch" placeholder="Buscar no cardápio..." value="${esc(menuSearch)}"><select aria-label="Filtrar categoria" id="orderProductCategory"><option value="">Todas as categorias</option>${cats.map(c=>`<option value="${esc(c)}" ${c===menuCategory?'selected':''}>${esc(c)}</option>`).join('')}</select></div><div class="order-menu">${products.length?products.map(p=>`<div class="menu-item"><span><strong>${esc(p.name)}</strong><small>${esc(p.category)} · ${api.money(p.price)}${p.trackStock?` · ${p.stock} em estoque`:''}</small></span><div class="qty-actions"><button type="button" data-draft-remove="${esc(p.id)}" ${!orderDraft[p.id]?'disabled':''} aria-label="Diminuir ${esc(p.name)}">−</button><b>${orderDraft[p.id]||0}</b><button type="button" data-draft-add="${esc(p.id)}" ${p.trackStock&&p.stock<=(orderDraft[p.id]||0)?'disabled':''} aria-label="Adicionar ${esc(p.name)}">+</button></div></div>`).join(''):'<div class="illustrated-empty">Cadastre produtos ou ajuste sua busca para lançar pedidos.</div>'}</div><div class="send-bar"><div><small>Novos itens</small><b>${api.money(draftTotal)}</b></div><button class="primary" id="sendOrderBtn" ${!Object.keys(orderDraft).length?'disabled':''}>Enviar pedido à cozinha →</button></div></div>`:''}
  <div class="order-history"><div class="subsection-heading"><h3>Pedidos lançados</h3><small>${o.batches.length} envio(s)</small></div>${batches||'<div class="illustrated-empty">Nenhum pedido enviado nesta comanda.</div>'}</div>
  <div class="order-checkout"><div class="checkout-total"><span>Total da comanda</span><strong>${api.money(orderTotal(o))}</strong></div>${editable?`<div class="checkout-action checkout-action-modern"><div class="checkout-payment"><div class="payment-title"><span>Forma de pagamento</span><small>Selecione antes de finalizar</small></div><div class="payment-options compact" role="radiogroup" aria-label="Forma de pagamento da comanda">${paymentButtons(orderPayment)}</div></div><button class="primary close-order-button" id="closeOrderBtn" ${!o.batches.length?'disabled':''}>Fechar e receber</button></div>`:`<p>Fechada em ${dateText(o.closedAt)} · ${esc(o.payment||'Pagamento não informado')}</p>`}</div>`;
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
  document.getElementById('kitchenBoard').innerHTML=filtered.length?filtered.map(({o,b})=>`<article class="kitchen-ticket status-${b.status}"><div class="kitchen-ticket-head"><span class="order-num">#${esc(o.number)}</span>${pill(batchStatus[b.status]?.[0]||b.status,batchStatus[b.status]?.[1])}</div><h3>${esc(o.customer||`Mesa ${o.table}`)}</h3><small>${esc(o.table?`Mesa ${o.table} · `:'')}${esc(o.waiter||'Balcão')} · ${dateText(b.createdAt)}</small><div class="ticket-lines">${b.items.map(i=>`<div><b>${i.qty}×</b><span>${esc(i.name)} <small>· ${esc(i.area)}</small></span></div>`).join('')}</div>${next[b.status]?`<button class="secondary kitchen-next" data-batch-id="${esc(b.id)}" data-kitchen-status="${next[b.status][1]}">${next[b.status][0]} →</button>`:'<div class="ticket-finished">✓ Entregue</div>'}</article>`).join(''):'<div class="illustrated-empty full-width">Nenhum pedido nesta etapa. Novos pedidos aparecem assim que o garçom envia a comanda.</div>';
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