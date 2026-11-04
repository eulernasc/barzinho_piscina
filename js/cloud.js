import {firebaseConfig} from './firebase-config.js';
import {initializeApp, deleteApp} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, signOut,
  createUserWithEmailAndPassword, deleteUser
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  getFirestore, doc, collection, getDocFromServer, getDocsFromServer,
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
  const app=initializeApp(firebaseConfig),auth=getAuth(app),firestore=getFirestore(app);
  const metaRef=doc(firestore,'barzinho','principal');
  let saved=emptyDb(),revision=0,current=null,saving=false,ready=false;
  let unlistenRole=()=>{},unlistenMeta=()=>{};
  let adminListBusy=false;

  async function readCloud() {
    const [meta,...snapshots]=await Promise.all([
      getDocFromServer(metaRef),
      ...entities.map(k=>getDocsFromServer(collection(firestore,'barzinho','principal',k)))
    ]);
    const next=emptyDb();
    entities.forEach((key,index)=>{next[key]=snapshots[index].docs.map(d=>d.data().value).filter(Boolean)});
    revision=meta.exists()?Number(meta.data().revision||0):0;
    next.orderCounter=meta.exists()?Number(meta.data().orderCounter||1000):1000;
    saved=clone(next);
    setDb(next);
    renderAll();
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
    unlistenMeta=onSnapshot(metaRef,snap=>{
      if(!ready||saving)return;
      const remote=Number(snap.data()?.revision||0);
      if(remote!==revision) readCloud().catch(e=>setMessage('syncState','Falha na atualização: '+humanError(e)));
    },e=>setMessage('syncState','Conexão de dados: '+humanError(e)));
    unlistenRole=onSnapshot(doc(firestore,'users',user.uid),snap=>{
      if(!snap.exists()||snap.data().active!==true) signOut(auth);
    },()=>signOut(auth));
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
  onAuthStateChanged(auth,async user=>{
    exit();
    if(!user){setMessage('loginStatus','Entre com sua conta Google autorizada ou com o e-mail e senha cadastrados pelo administrador.');return;}
    setMessage('loginStatus','Verificando autorização...');
    try{
      const record=await getDocFromServer(doc(firestore,'users',user.uid));
      if(!record.exists()||record.data().active!==true) {
        setMessage('loginStatus','Conta sem autorização ou bloqueada. Procure o administrador.');
        await signOut(auth);return;
      }
      await showAuthorized(user,record.data());
      setMessage('loginStatus','');
    }catch(e){setMessage('loginStatus','Falha na verificação: '+humanError(e));await signOut(auth);}
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