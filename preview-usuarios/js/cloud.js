import {firebaseConfig} from './firebase-config.js';
import {initializeApp, deleteApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut,
  createUserWithEmailAndPassword, deleteUser
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  initializeFirestore, doc, collection, getDocFromServer, getDocsFromServer,
  getDocs, setDoc, updateDoc, onSnapshot, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

// Firebase users may authenticate without being authorized. Every data operation
// MUST also pass Firestore rules that check users/{uid}. Never trust a UI flag.
const entities = ['products','sales','orders','movements','purchases','stockAdjustments'];
const emptyDb = () => ({products:[],sales:[],orders:[],movements:[],purchases:[],stockAdjustments:[],orderCounter:1000});
const clone = v => JSON.parse(JSON.stringify(v));
const byId = arr => new Map((arr||[]).map(x => [String(x.id),x]));
const humanError = e => {
  const code = e?.code||'';
  if (code === 'auth/invalid-credential') return 'E-mail ou senha incorretos.';
  if (code === 'auth/email-already-in-use') return 'Este e-mail já está cadastrado no Firebase.';
  if (code === 'auth/weak-password') return 'Senha muito fraca. Use pelo menos 8 caracteres.';
  if (code === 'auth/popup-blocked') return 'O navegador bloqueou a janela do Google. Habilite pop-ups e tente novamente.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Entrada com Google cancelada.';
  if (code === 'auth/unauthorized-domain') return 'Domínio não autorizado. Adicione o endereço do site em Authentication > Configurações > Domínios autorizados.';
  if (code === 'auth/operation-not-allowed') return 'Provedor de login desativado no Firebase Authentication.';
  if (code === 'permission-denied') return 'Permissão negada. Verifique seu cadastro e as regras do Firestore.';
  if (code === 'unavailable') return 'Sem conexão com o banco. Nada foi confirmado.';
  return e?.message||'Não foi possível completar a operação.';
};
const field = id => document.getElementById(id);
const setMessage = (id,msg) => {const e=field(id);if(e)e.textContent=msg||'';};
const configReady = () => !!(firebaseConfig?.apiKey && firebaseConfig?.projectId && firebaseConfig?.authDomain && firebaseConfig?.appId);

export function startCloud({getDb,setDb,renderAll,authorized,revoked,toast}) {
  if (!configReady()) {
    setMessage('loginStatus','Firebase não configurado. Preencha js/firebase-config.js e publique as regras antes de ativar esta versão.');
    field('loginScreen').hidden=false;
    return {saveDb:async()=>{throw Error('Firebase ainda não configurado.')},isActive:()=>false};
  }
  const app=initializeApp(firebaseConfig),auth=getAuth(app);
  // O Firestore pode ter um banco nomeado "default", diferente de "(default)".
  // A escolha só ocorre após localizar o perfil pelo token Firebase do usuário.
  let databaseId=null,firestore=null,metaRef=null;
  function selectDatabase(id){
    if(databaseId && databaseId!==id)throw Error('O banco já foi selecionado para esta sessão.');
    if(!firestore) {
      firestore=initializeFirestore(app,{experimentalForceLongPolling:true},id);
      metaRef=doc(firestore,'barzinho','principal');
    }
    databaseId=id;
  }
  let saved=emptyDb(),revision=0,current=null,saving=false,ready=false;
  let unlistenRole=()=>{},unlistenMeta=()=>{};
  let adminListBusy=false;
  let authCheckSerial=0;
  function timeoutAfter(promise,label,ms=15000){
    let timer;
    return Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>{
        reject(new Error(label+' não respondeu em '+Math.round(ms/1000)+' segundos. Verifique sua conexão com o Firestore e tente novamente.'));
      },ms);})
    ]).finally(()=>clearTimeout(timer));
  }
  function showRetry(message){
    setMessage('loginStatus',message);
    const button=field('retryAuthButton');
    if(button)button.hidden=false;
    const switchButton=field('switchGoogleAccount');
    if(switchButton)switchButton.hidden=false;
  }
  function showAuthDiagnostics(user,profile){
    const wrap=field('authDiagnostics');
    if(!wrap)return;
    if(!user){wrap.hidden=true;return;}
    wrap.hidden=false;
    const provider=user.providerData?.map(p=>p.providerId).join(', ')||'Firebase';
    const status=profile===undefined?'Aguardando verificação':!profile?'Documento users/ não encontrado':profile.active===true?'Ativo':'Documento encontrado, mas active não é true';
    const email=user.email||'(sem e-mail)';
    const diagnostics=['Projeto: '+firebaseConfig.projectId,'Banco Firestore: '+(databaseId||'verificando'), 'E-mail autenticado: '+email,'UID autenticado: '+user.uid,'Provedor: '+provider,'Perfil Firestore: '+status].join('\n');
    wrap.textContent=diagnostics;
    const copy=field('copyAuthDiagnostics');
    if(copy){
      copy.hidden=false;
      copy.onclick=()=>{
        navigator.clipboard?.writeText(wrap.textContent).then(()=>setMessage('loginStatus','Diagnóstico copiado. Não compartilhe senhas nem tokens.')).catch(()=>{});
      };
    }
  }


  // REST uses the signed-in user's Firebase ID token and the SAME Firestore Rules.
  // It avoids the hanging streaming channel observed in some browsers.
  const projectRoot='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(firebaseConfig.projectId)+'/databases/';
  function firestoreValue(v){
    if(!v)return null;
    if('nullValue' in v)return null;
    if('booleanValue' in v)return v.booleanValue;
    if('integerValue' in v)return Number(v.integerValue);
    if('doubleValue' in v)return Number(v.doubleValue);
    if('stringValue' in v)return v.stringValue;
    if('timestampValue' in v)return v.timestampValue;
    if('arrayValue' in v)return (v.arrayValue.values||[]).map(firestoreValue);
    if('mapValue' in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,val])=>[k,firestoreValue(val)]));
    return null;
  }
  function firestoreFields(record){
    return Object.fromEntries(Object.entries(record?.fields||{}).map(([key,value])=>[key,firestoreValue(value)]));
  }
  async function restGet(path,{allow404=false,ms=12000,targetDb=null}={}){
    const user=auth.currentUser;
    if(!user)throw Error('Sua sessão expirou. Entre novamente.');
    const token=await timeoutAfter(user.getIdToken(),'Autenticação Firebase',ms);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),ms);
    try{
      const db=targetDb||databaseId;
      if(!db)throw Error('Banco Firestore não selecionado.');
      const base=projectRoot+encodeURIComponent(db)+'/documents/';
      const response=await fetch(base+path,{
        method:'GET',
        headers:{Authorization:'Bearer '+token},
        signal:controller.signal,
        cache:'no-store'
      });
      if(!response.ok){
        let body={};try{body=await response.json()}catch{}
        const reason=body.error?.message||response.statusText||'Erro inesperado';
        const status=response.status;
        if(status===404){
          if(allow404 && !/database (was )?not found|requested database|database .* does not exist/i.test(reason))return null;
          const error=new Error('Firestore 404 no banco '+db+': '+reason);
          error.httpStatus=404;
          throw error;
        }
        if(status===403){const err=Error('Firestore negou a leitura (403) no banco '+db+': '+reason);err.httpStatus=403;throw err;}
        if(status===401){const err=Error('Sessão inválida (401). Entre novamente.');err.httpStatus=401;throw err;}
        throw Error('Firestore HTTP '+status+': '+reason);
      }
      return await response.json();
    }catch(e){
      if(e.name==='AbortError')throw Error('O endereço firestore.googleapis.com não respondeu. Verifique bloqueio de rede, VPN ou proteção do navegador.');
      if(e.name==='TypeError')throw Error('Falha de rede ou bloqueio da API firestore.googleapis.com neste navegador.');
      throw e;
    }finally{clearTimeout(timer);}
  }
  // Queries use :runQuery because this database allows authenticated queries
  // but returns 403 to the REST listDocuments endpoint, even for admin.
  // Fetch every page in stable document-name order. Never return partial data.
  async function queryCollection(collectionPath){
    const slash=collectionPath.lastIndexOf('/');
    const parent=slash>=0?collectionPath.slice(0,slash):'';
    const collectionId=slash>=0?collectionPath.slice(slash+1):collectionPath;
    if(!databaseId || !auth.currentUser)throw Error('Faça login para consultar os dados.');
    const endpoint=projectRoot+encodeURIComponent(databaseId)
      +'/documents'+(parent?'/'+parent:'')+':runQuery';
    const pageSize=250,documents=[];
    let lastName=null;
    for(let page=0;page<60;page++){
      const token=await timeoutAfter(auth.currentUser.getIdToken(),'Token Firebase',12000);
      const structuredQuery={
        from:[{collectionId}],
        orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],
        limit:pageSize
      };
      if(lastName)structuredQuery.startAt={
        values:[{referenceValue:lastName}],before:false
      };
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),18000);
      let result;
      try{
        const response=await fetch(endpoint,{
          method:'POST',
          headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
          body:JSON.stringify({structuredQuery}),
          cache:'no-store',signal:controller.signal
        });
        if(!response.ok){
          const payload=await response.json().catch(()=>({}));
          const reason=payload.error?.message||response.statusText;
          const e=new Error('Falha ao consultar '+collectionPath+' (HTTP '+response.status+'): '+reason);
          e.httpStatus=response.status;
          throw e;
        }
        result=await response.json();
        if(!Array.isArray(result))throw Error('Resposta inválida na consulta de '+collectionPath+'.');
      }catch(e){
        if(e.name==='AbortError')throw Error('Tempo esgotado ao consultar '+collectionPath+'.');
        if(e.name==='TypeError')throw Error('Falha de rede ao consultar '+collectionPath+'.');
        throw e;
      }finally{clearTimeout(timer)}
      const batch=result.map(r=>r.document).filter(Boolean);
      if(batch.some(doc=>!doc.name))throw Error('Documento sem identificação em '+collectionPath+'.');
      documents.push(...batch);
      if(documents.length>12000)throw Error('Limite de registros atingido em '+collectionPath+'. Contate o administrador.');
      if(batch.length<pageSize)return documents;
      const nextLast=batch[batch.length-1].name;
      if(nextLast===lastName)throw Error('Paginação repetida em '+collectionPath+'.');
      lastName=nextLast;
    }
    throw Error('Limite de páginas atingido ao consultar '+collectionPath+'.');
  }
  async function restList(key){
    return queryCollection('barzinho/principal/'+key);
  }
  async function readProfile(user){
    if(databaseId){
      const record=await restGet('users/'+encodeURIComponent(user.uid),{allow404:true,ms:12000});
      return record?firestoreFields(record):null;
    }
    const errors=[];
    // O console mostra "default". Primeiro buscamos neste banco nomeado;
    // se não existir o documento, verificamos o banco padrão "(default)".
    for(const id of ['default','(default)']){
      try{
        const record=await restGet('users/'+encodeURIComponent(user.uid),{ms:12000,targetDb:id});
        if(record){
          selectDatabase(id);
          return firestoreFields(record);
        }
      }catch(e){
        if(e.httpStatus===404){errors.push(id+': '+e.message);continue}
        throw e;
      }
    }
    throw Error('Não foi encontrado o documento do seu UID nos bancos default e (default). Detalhes: '+errors.join(' | '));
  }
  // Diagnóstico SOMENTE leitura: nunca cria documentos, altera regras, nem mostra tokens.
  // Comparar listDocuments com runQuery usando o mesmo token, sem gravar.
  async function diagnoseQuery(collectionPath){
    const slash=collectionPath.lastIndexOf('/');
    const parent=slash<0?'':collectionPath.slice(0,slash);
    const col=slash<0?collectionPath:collectionPath.slice(slash+1);
    const token=await timeoutAfter(auth.currentUser.getIdToken(),'Token Firebase',9000);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),9000);
    try{
      const endpoint=projectRoot+encodeURIComponent(databaseId)
        +'/documents'+(parent?'/'+parent:'')+':runQuery';
      const response=await fetch(endpoint,{
        method:'POST',
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({structuredQuery:{from:[{collectionId:col}],limit:1}}),
        signal:controller.signal,cache:'no-store'
      });
      if(!response.ok){
        const payload=await response.json().catch(()=>({}));
        return response.status+' — '+(payload.error?.message||'acesso negado');
      }
      return 'OK (200)';
    }catch(e){
      return e.name==='AbortError'?'tempo esgotado':String(e.message||e);
    }finally{clearTimeout(timer)}
  }
  async function diagnosePermissions(user,profile,serial,originalError){
    if(!user||!profile||!databaseId)return;
    const results=[
      ['Perfil por UID (GET)', 'users/'+encodeURIComponent(user.uid)],
      ['Listagem de usuários (LIST)', 'users?pageSize=1'],
      ['Documento principal (GET)', 'barzinho/principal'],
      ['Produto inexistente (GET)', 'barzinho/principal/products/validacao_doc_inexistente_20261104'],
      ['Produtos (LIST)', 'barzinho/principal/products?pageSize=1'],
      ['Vendas (LIST)', 'barzinho/principal/sales?pageSize=1'],
      ['Comandas (LIST)', 'barzinho/principal/orders?pageSize=1']
    ];
    const readings=await Promise.all(results.map(async ([name,path])=>{
      try{
        await restGet(path,{ms:9000});
        return name+': OK (200)';
      }catch(e){
        const status=e.httpStatus||(e.message?.match(/(?:HTTP |Firestore )(40[134]|50[0-9])/i)?.[1])||'?';
        return name+': '+status+' — '+(status==404?'documento ou recurso ausente':status==403?'acesso negado':String(e.message).slice(0,110));
      }
    }));
    const queryResults=await Promise.all([
      diagnoseQuery('users'),
      diagnoseQuery('barzinho/principal/products')
    ]);
    readings.push('Usuários (runQuery): '+queryResults[0]);
    readings.push('Produtos (runQuery): '+queryResults[1]);
    if(serial!==authCheckSerial)return;
    const box=field('authDiagnostics');
    if(box){
      box.hidden=false;
      box.textContent+='\n\nTESTE DE PERMISSÕES (somente leitura):\n'
        +'Perfil informado: active='+String(profile.active)+', role='+String(profile.role)+'\n'
        +readings.join('\n');
    }
    // listDocuments may fail while runQuery succeeds; do NOT misdiagnose
    // this as a missing admin role.
    const runUsers=queryResults[0],runProducts=queryResults[1];
    const reason=humanError(originalError||new Error('Falha desconhecida'));
    if(runUsers==='OK (200)' && runProducts==='OK (200)'){
      setMessage('loginStatus','As consultas runQuery de usuários e produtos estão permitidas. Falhou uma etapa específica: '+reason+'. Veja os testes abaixo.');
    }else{
      setMessage('loginStatus','Falha ao carregar: '+reason+'. Consulte os resultados runQuery detalhados abaixo.');
    }
  }

  let reloadPromise=null;
  async function readCloud(){
    if(reloadPromise)return reloadPromise;
    reloadPromise=(async()=>{
      setMessage('syncState','Atualizando dados do bar...');
      const [meta,...snapshots]=await Promise.all([
        restGet('barzinho/principal',{allow404:true}),
        ...entities.map(key=>restList(key))
      ]);
      const next=emptyDb();
      entities.forEach((key,index)=>{
        const docs=snapshots[index]||[];
        next[key]=docs.map(d=>firestoreFields(d).value).filter(Boolean);
      });
      const metadata=meta?firestoreFields(meta):{};
      revision=Number(metadata.revision||0);
      next.orderCounter=Number(metadata.orderCounter||1000);
      saved=clone(next);
      setDb(next);
      renderAll();
      setMessage('syncState','Dados recebidos do Firestore.');
    })();
    try{return await reloadPromise}finally{reloadPromise=null}
  }

  // Detect changes by ID and avoid rewriting all sales on every new order.
  function diffData(before,after) {
    const changes=[];
    for(const key of entities) {
      const oldMap=byId(before[key]),newMap=byId(after[key]);
      for(const [id,value] of newMap) {
        if (!id || id.includes('/')) throw Error('ID inválido.');
        if (JSON.stringify(oldMap.get(id))!==JSON.stringify(value)) changes.push({key,id,value});
      }
      for(const id of oldMap.keys()) if(!newMap.has(id))changes.push({key,id,remove:true});
    }
    return changes;
  }

  async function saveDb() {
    if(!current||!ready) throw Error('Faça login com uma conta autorizada antes de salvar.');
    if(saving)throw Error('Há outro salvamento em andamento. Aguarde a confirmação.');
    saving=true;
    const expectedRevision=revision, next=clone(getDb()),changes=diffData(saved,next);
    if(changes.length>430) { saving=false; throw Error('Muitos registros alterados de uma vez. Divida a importação em lotes menores.'); }
    if(!changes.length && next.orderCounter===saved.orderCounter) { saving=false; return; }
    try {
      await runTransaction(firestore,async transaction=>{
        const meta=await transaction.get(metaRef);
        const remoteRevision=meta.exists()?Number(meta.data().revision||0):0;
        if(remoteRevision!==expectedRevision)throw Error('Os dados mudaram em outro dispositivo. As informações foram recarregadas; confira e tente novamente.');
        for(const change of changes){
          const ref=doc(firestore,'barzinho','principal',change.key,change.id);
          if(change.remove)transaction.delete(ref);
          else transaction.set(ref,{value:change.value,updatedAt:serverTimestamp()});
        }
        transaction.set(metaRef,{revision:remoteRevision+1,orderCounter:next.orderCounter,updatedAt:serverTimestamp()},{merge:true});
      });
      revision=expectedRevision+1;
      saved=clone(next);
      setMessage('syncState','Dados confirmados no Firestore.');
    } catch(e) {
      setMessage('syncState','Falha ao salvar: '+humanError(e));
      // Roll back optimistic UI data after a failed server commit.
      try{await readCloud()}catch(loadError){setDb(clone(saved));renderAll();}
      throw e;
    } finally {saving=false;}
  }

  async function login(event){
    event.preventDefault();
    const submit=field('loginSubmit');submit.disabled=true;
    setMessage('loginStatus','Verificando acesso...');
    try {
      await signInWithEmailAndPassword(auth,field('loginEmail').value.trim(),field('loginPassword').value);
      field('loginPassword').value='';
    } catch(e) {setMessage('loginStatus',humanError(e));}
    finally {submit.disabled=false;}
  }

  async function loginGoogle(){
    const submit=field('googleLoginButton');
    if(submit.disabled)return;
    submit.disabled=true;
    setMessage('loginStatus','Entrando com Google...');
    try{
      const provider=new GoogleAuthProvider();
      provider.setCustomParameters({prompt:'select_account'});
      // O Firebase autentica a identidade; somente users/{uid}.active=true
      // concede acesso aos dados do bar pelas regras do Firestore.
      await signInWithPopup(auth,provider);
    }catch(e){setMessage('loginStatus',humanError(e))}
    finally{submit.disabled=false}
  }

  async function showAuthorized(user,record){
    current={uid:user.uid,email:user.email,...record};
    setMessage('loginStatus','Conta autorizada. Carregando dados do bar...');
    await readCloud();
    if(!current)return;
    ready=true;
    field('loginScreen').hidden=true;
    field('appShell').hidden=false;
    field('currentUserEmail').textContent=user.email||'';
    field('usersNav').hidden=record.role!=='admin';
    field('importLocalButton').hidden=record.role!=='admin';
    setMessage('syncState','Dados sincronizados com Firestore.');
    authorized(current);
    // Poll via authenticated REST because the SDK streaming channel is the
    // reason the browser can hang; all operations still obey Firestore Rules.
    let checking=false;
    async function checkUpdates(){
      if(!ready||saving||checking||!auth.currentUser)return;
      checking=true;
      try{
        const profile=await readProfile(user);
        if(!profile||profile.active!==true){await signOut(auth);return}
        const meta=await restGet('barzinho/principal',{allow404:true});
        const currentRevision=meta?Number(firestoreFields(meta).revision||0):0;
        if(currentRevision!==revision)await readCloud();
      }catch(e){
        setMessage('syncState','Falha na sincronização: '+humanError(e));
      }finally{checking=false}
    }
    const timer=setInterval(checkUpdates,12000);
    unlistenMeta=()=>clearInterval(timer);
    unlistenRole=()=>{};
  }

  function exit(){
    ready=false;current=null;
    unlistenRole();unlistenMeta();
    unlistenRole=()=>{};unlistenMeta=()=>{};
    saved=emptyDb();revision=0;setDb(emptyDb());
    field('appShell').hidden=true;field('loginScreen').hidden=false;
    field('usersNav').hidden=true;field('importLocalButton').hidden=true;
    revoked();
  }
  async function verifyAuthorization(user){
    const serial=++authCheckSerial;
    exit();
    const retry=field('retryAuthButton');
    if(retry)retry.hidden=true;
    const changeAccount=field('switchGoogleAccount');if(changeAccount)changeAccount.hidden=true;
    const copyDiagnostics=field('copyAuthDiagnostics');if(copyDiagnostics)copyDiagnostics.hidden=true;
    showAuthDiagnostics(user,undefined);
    if(!user){
      setMessage('loginStatus','Entre com a conta Google autorizada ou com e-mail e senha.');
      return;
    }
    setMessage('loginStatus','Verificando seu perfil de acesso no Firestore...');
    let verifiedProfile=null;
    try{
      const profile=await readProfile(user);
      verifiedProfile=profile;
      if(serial!==authCheckSerial)return;
      showAuthDiagnostics(user,profile);
      if(!profile||profile.active!==true){
        showRetry('O perfil deste UID não está ativo. Compare o UID exibido abaixo com o ID do documento na coleção users. Se forem diferentes, clique em Trocar conta Google.');
        return;
      }
      await showAuthorized(user,profile);
      if(serial!==authCheckSerial)return;
      setMessage('loginStatus','');
    }catch(e){
      if(serial!==authCheckSerial)return;
      // Keep the session available for diagnosis; never grant access without a valid profile.
      showAuthDiagnostics(user,verifiedProfile);
      showRetry('Não foi possível concluir o acesso: '+humanError(e)+' Analisando permissões de leitura...');
      if(verifiedProfile && databaseId) {
        try { await diagnosePermissions(user,verifiedProfile,serial,e); }
        catch(diagError){if(serial===authCheckSerial)setMessage('loginStatus','Diagnóstico não concluiu: '+humanError(diagError));}
      }
    }
  }
  onAuthStateChanged(auth,user=>verifyAuthorization(user));
  field('retryAuthButton').addEventListener('click',()=>{
    if(auth.currentUser)verifyAuthorization(auth.currentUser);
    else setMessage('loginStatus','Selecione Entrar com Google para autenticar novamente.');
  });
  field('switchGoogleAccount').addEventListener('click',async()=>{
    try{
      authCheckSerial++;
      await signOut(auth);
      await loginGoogle();
    }catch(e){showRetry('Falha ao trocar conta: '+humanError(e))}
  });
  field('loginForm').addEventListener('submit',login);
  field('googleLoginButton').addEventListener('click',loginGoogle);
  field('logoutButton').addEventListener('click',()=>signOut(auth));

  async function renderUsers(){
    if(current?.role!=='admin')return;
    if(adminListBusy)return;adminListBusy=true;
    const table=field('usersTable');
    table.textContent='Carregando usuários...';
    try {
      const accounts=await queryCollection('users');
      table.replaceChildren();
      for(const account of accounts){
        const id=account.name.split('/').pop();
        const u=firestoreFields(account);
        const row=document.createElement('div');row.className='team-user-row';
        const identity=document.createElement('div');
        const name=document.createElement('strong');name.textContent=u.name||u.email||'Usuário';
        const info=document.createElement('small');info.textContent=(u.email||'')+' · '+(u.role==='admin'?'Administrador':'Equipe');
        identity.append(name,info);row.append(identity);
        if(id===current.uid||u.role==='admin'){
          const status=document.createElement('span');status.textContent='Administrador';row.append(status);
        } else {
          const action=document.createElement('button');
          action.className='secondary';action.type='button';
          action.textContent=u.active===true?'Bloquear':'Reativar';
          action.addEventListener('click',async()=>{
            action.disabled=true;
            try{await updateDoc(doc(firestore,'users',id),{active:u.active!==true,updatedAt:serverTimestamp()});
              toast('Acesso atualizado.');await renderUsersAfterAction();
            }catch(e){toast('Erro: '+humanError(e));action.disabled=false;}
          });
          row.append(action);
        }
        table.append(row);
      }
    }catch(e){table.textContent='Não foi possível listar usuários: '+humanError(e);}
    finally{adminListBusy=false;}
  }
  async function renderUsersAfterAction(){adminListBusy=false;await renderUsers();}

  async function addUser(event){
    event.preventDefault();
    if(current?.role!=='admin')return;
    const name=field('newUserName').value.trim(),email=field('newUserEmail').value.trim().toLowerCase(),pass=field('newUserPassword').value;
    if(!name||pass.length<8){setMessage('usersStatus','Preencha o nome e utilize senha com pelo menos 8 caracteres.');return;}
    const submit=field('newUserSubmit');submit.disabled=true;
    setMessage('usersStatus','Criando usuário...');
    let auxiliary=null,created=null;
    try{
      auxiliary=initializeApp(firebaseConfig,'cadastro-temporario-'+Date.now());
      const auxiliaryAuth=getAuth(auxiliary);
      const result=await createUserWithEmailAndPassword(auxiliaryAuth,email,pass);
      created=result.user;
      await setDoc(doc(firestore,'users',created.uid),{
        name,email,role:'staff',active:true,
        createdAt:serverTimestamp(),createdBy:current.uid
      });
      field('newUserForm').reset();
      setMessage('usersStatus','Usuário criado e autorizado.');
      await renderUsers();
    }catch(e){
      if(created) {try{await deleteUser(created)}catch{}}
      setMessage('usersStatus','Cadastro não concluído: '+humanError(e));
    }finally{
      if(auxiliary){try{await deleteApp(auxiliary)}catch{}}
      submit.disabled=false;
    }
  }
  field('newUserForm').addEventListener('submit',addUser);
  field('usersRefresh').addEventListener('click',renderUsers);

  async function importLocal(){
    if(current?.role!=='admin')return;
    const raw=localStorage.getItem('barzinhoPiscinaDB_v1');
    if(!raw){toast('Não há dados locais neste navegador.');return;}
    let legacy;try{legacy=JSON.parse(raw)}catch{toast('Backup local inválido.');return;}
    if(entities.some(k=>(getDb()[k]||[]).length)){toast('Importação bloqueada: o banco já contém dados.');return;}
    const count=entities.reduce((n,k)=>n+(legacy[k]?.length||0),0);
    if(!count){toast('Backup local vazio.');return;}
    if(count>400){toast('Importação muito grande. Precisa ser dividida, preservando os registros.');return;}
    if(!confirm('Importar '+count+' registros locais para o Firestore? Confirme que este é o navegador com os dados corretos. O backup local será preservado.'))return;
    setDb({...emptyDb(),...legacy});
    try{await saveDb();renderAll();toast('Importação confirmada no Firestore. Backup local preservado.');}
    catch(e){toast('Importação não concluída: '+humanError(e));}
  }
  field('importLocalButton').addEventListener('click',importLocal);

  return {saveDb,isActive:()=>!!ready,renderUsers,loginUser:()=>current};
}