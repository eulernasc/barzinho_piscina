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
  // Long-polling avoids WebChannel connections that can stall behind some proxies.
  const firestore=initializeFirestore(app,{experimentalForceLongPolling:true});
  const metaRef=doc(firestore,'barzinho','principal');
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
  }


  // REST uses the signed-in user's Firebase ID token and the SAME Firestore Rules.
  // It avoids the hanging streaming channel observed in some browsers.
  const restBase='https://firestore.googleapis.com/v1/projects/'+encodeURIComponent(firebaseConfig.projectId)+'/databases/(default)/documents';
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
  async function restGet(path,{allow404=false,ms=12000}={}){
    const user=auth.currentUser;
    if(!user)throw Error('Sua sessão expirou. Entre novamente.');
    const token=await timeoutAfter(user.getIdToken(),'Autenticação Firebase',ms);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),ms);
    try{
      const response=await fetch(restBase+'/'+path,{
        method:'GET',
        headers:{Authorization:'Bearer '+token},
        signal:controller.signal,
        cache:'no-store'
      });
      if(allow404&&response.status===404)return null;
      if(!response.ok){
        let body={};try{body=await response.json()}catch{}
        const reason=body.error?.message||response.statusText||'Erro inesperado';
        const status=response.status;
        if(status===403)throw Error('Firestore negou a leitura (403). Verifique regras e o UID cadastrado em users/.');
        if(status===401)throw Error('Sessão inválida (401). Entre novamente.');
        if(status===404)throw Error('Documento não encontrado (404).');
        throw Error('Firestore HTTP '+status+': '+reason);
      }
      return await response.json();
    }catch(e){
      if(e.name==='AbortError')throw Error('O endereço firestore.googleapis.com não respondeu. Verifique bloqueio de rede, VPN ou proteção do navegador.');
      if(e.name==='TypeError')throw Error('Falha de rede ou bloqueio da API firestore.googleapis.com neste navegador.');
      throw e;
    }finally{clearTimeout(timer);}
  }
  async function restList(key){
    const all=[];let pageToken='';
    do{
      const suffix='barzinho/principal/'+key+'?pageSize=300'+(pageToken?'&pageToken='+encodeURIComponent(pageToken):'');
      const result=await restGet(suffix,{allow404:true});
      if(result?.documents)all.push(...result.documents);
      pageToken=result?.nextPageToken||'';
      if(all.length>12000)throw Error('Volume de dados acima do limite de leitura. Contate o administrador.');
    }while(pageToken);
    return all;
  }
  async function readProfile(user){
    const record=await restGet('users/'+encodeURIComponent(user.uid),{allow404:true,ms:12000});
    return record?firestoreFields(record):null;
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
    if(!user){
      setMessage('loginStatus','Entre com a conta Google autorizada ou com e-mail e senha.');
      return;
    }
    setMessage('loginStatus','Verificando seu perfil de acesso no Firestore...');
    try{
      const profile=await readProfile(user);
      if(serial!==authCheckSerial)return;
      if(!profile||profile.active!==true){
        showRetry('A conta está autenticada, mas não tem um perfil ativo no Firestore. Confirme o UID em users/ e tente novamente.');
        return;
      }
      await showAuthorized(user,profile);
      if(serial!==authCheckSerial)return;
      setMessage('loginStatus','');
    }catch(e){
      if(serial!==authCheckSerial)return;
      // Keep the Firebase session alive; a transient Firestore failure should
      // not force a new Google popup.
      showRetry('Não foi possível concluir o acesso: '+humanError(e));
    }
  }
  onAuthStateChanged(auth,user=>verifyAuthorization(user));
  field('retryAuthButton').addEventListener('click',()=>{
    if(auth.currentUser)verifyAuthorization(auth.currentUser);
    else setMessage('loginStatus','Selecione Entrar com Google para autenticar novamente.');
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
      const snap=await getDocs(collection(firestore,'users'));
      table.replaceChildren();
      for(const account of snap.docs){
        const u=account.data();
        const row=document.createElement('div');row.className='team-user-row';
        const identity=document.createElement('div');
        const name=document.createElement('strong');name.textContent=u.name||u.email||'Usuário';
        const info=document.createElement('small');info.textContent=(u.email||'')+' · '+(u.role==='admin'?'Administrador':'Equipe');
        identity.append(name,info);row.append(identity);
        if(account.id===current.uid||u.role==='admin'){
          const status=document.createElement('span');status.textContent='Administrador';row.append(status);
        } else {
          const action=document.createElement('button');
          action.className='secondary';action.type='button';
          action.textContent=u.active===true?'Bloquear':'Reativar';
          action.addEventListener('click',async()=>{
            action.disabled=true;
            try{await updateDoc(doc(firestore,'users',account.id),{active:u.active!==true,updatedAt:serverTimestamp()});
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