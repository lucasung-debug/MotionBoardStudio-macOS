'use strict';

// Explicit CLI-only offline acceptance. These providers are never installed in
// the user-facing app and never read Keychain, cookies, or account stores.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { createRenderer } = require('./render.cjs');
const { createStore } = require('./store.cjs');
const { createImageVideoMedia } = require('./image-video-media.cjs');
const requireOK = result => { if (!result?.ok) throw new Error(result?.error || 'Operation failed.'); return result; };

function fixturePNG() {
  const crc = data => {
    let c = 0xffffffff;
    for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const head = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([head, data])));
    return Buffer.concat([size, head, data, checksum]);
  };
  const width = 256, height = 256, bytes = Buffer.alloc((width * 3 + 1) * height);
  const palette = [[15,24,43],[215,38,57],[247,244,239],[34,118,164]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = palette[(Math.floor(x / 64) + Math.floor(y / 64)) % 4];
    for (let c = 0; c < 3; c++) bytes[y * (width * 3 + 1) + 1 + x * 3 + c] = color[c];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]);
}

async function createVerification({sourceRoot, userData, nativeCall}) {
  const library = name => require(path.join(sourceRoot, 'lib', name));
  const compose = library('video/compose.cjs'), direction = library('video/script.cjs'), audio = library('video/audio.cjs');
  compose.CANVAS['1:1'] = [320,320]; compose.CANVAS['16:9'] = [320,180]; compose.CANVAS['9:16'] = [180,320];
  const phases = [];
  const specification = {title:'Mac offline verification',concept:'Synthetic local source-parity fixture.',
    yaml:'project:\n  title: Mac offline verification\n  duration: 8\nscenes: []\nmusic:\n  search_terms: [synthetic]\n',
    image_prompt:'A synthetic local four-by-four color study.',notes:['Offline test provider; no actual AI request.']};
  const script = {title:'맥 모션',mood:'energetic',motif:'diamond',palette:{bg:'#10182B',surface:'#F7F4EF',ink:'#F7F4EF',accent:'#D72639',accent2:'#2276A4'},shots:[
    {type:'title',lines:['맥 모션'],sub:'LOCAL STUDY',beats:3,transition:'cut'},
    {type:'motif',labels:['BALL','PLAY'],shapes:['diamond','circle'],beats:3,transition:'wipe'},
    {type:'split',a:'PLAY',b:'BALL',beats:2,transition:'push'},
    {type:'stack',items:['리듬','움직임','함께'],beats:3,transition:'iris'},
    {type:'pattern',pattern:'stripes',text:'MOTION',beats:3,transition:'wipe'},
    {type:'end',lines:['다시 시작'],beats:2,transition:'zoom'}]};
  const code = '<mk-fonts></mk-fonts><mk-css>#stage{background:#10182b}#word{position:absolute;left:15%;top:35%;color:#f7f4ef;font:bold 34px system-ui}</mk-css><mk-html><div id="word">맥 모션</div></mk-html><mk-js>MK.define({build(){},render(t){document.getElementById("word").style.transform="translateX("+(Math.sin(t/MK.T*Math.PI*2)*30)+"px)";}});</mk-js>';
  const chat = async request => {
    const text = request.userText || request.input?.[0]?.content?.find(x => x.type === 'input_text')?.text || '';
    let content;
    if (String(request.instructions).includes('모션보드 스튜디오 실행 모드')) { content = JSON.stringify(specification); phases.push('specification'); }
    else if (text.includes('[프레임 점검]')) { content = '{"ok":true}'; phases.push('frame-review'); }
    else if (String(request.finalDirective || text).includes('<mk-')) { content = code; phases.push('free-code'); }
    else { content = JSON.stringify(script); phases.push('direction'); }
    request.onDelta?.({kind:'text',text:content});
    return {content,model:'offline-fixture',reasoningEffort:'fixture',effort:'fixture'};
  };
  const status = async () => ({loggedIn:true,source:'offline-verification'});
  const authServices = {chatgpt:{status,getAuth:async()=>({accessToken:'fixture-token',accountId:'fixture-account'})},claude:{status,getAuth:async()=>({token:'fixture-token'})}};
  const injections = {authServices, testProviders:{codex:{chat,generateImage:async()=>({buffer:fixturePNG(),model:'offline-fixture'})},claude:{chat},fetchImpl:globalThis.fetch}};

  async function run(engine, { fullSize = false } = {}) {
    if (fullSize) {
      compose.CANVAS['1:1'] = [1440,1440]; compose.CANVAS['16:9'] = [1920,1080]; compose.CANVAS['9:16'] = [1080,1920];
    }
    const output = path.join(userData, 'verification'); await fs.mkdir(output,{recursive:true});
    const env = requireOK(await engine.invoke('studio:env'));
    if (!env.ffmpeg) throw new Error('FFmpeg is required for native verification.');
    requireOK(await engine.invoke('studio:guide'));
    if (requireOK(await engine.invoke('studio:history')).entries.length) throw new Error('Verification requires a new, empty data directory.');
    const entry = requireOK(await engine.invoke('studio:spec',{topic:'맥 모션 검증',provider:'chatgpt',mode:'full',aspectRatio:'16:9',durationSeconds:8})).entry;
    const board = requireOK(await engine.invoke('studio:board',{id:entry.id})).entry;
    if (!board.hasImage) throw new Error('Fixture board did not attach to the production entry.');

    const samples = new Float32Array(24 * audio.SR * 2);
    for (let i=0;i<samples.length/2;i++) {
      const t=i/audio.SR, phase=t%0.5;
      const value=0.45*Math.exp(-phase*55)*Math.sin(2*Math.PI*95*t)+0.025*Math.sin(2*Math.PI*330*t);
      samples[i*2]=value; samples[i*2+1]=value;
    }
    const musicFile=path.join(output,'synthetic-music.wav'); await fs.writeFile(musicFile,audio.wavBuffer(samples));
    const video = requireOK(await engine.invoke('studio:video',{id:entry.id,options:{provider:'claude',engine:'direct',musicSource:'file',musicFile,quality:fullSize?'final':'draft',review:true}})).entry;
    if (!video.hasVideo || video.videoMeta?.engine!=='direct' || !video.videoMeta?.music || !phases.includes('frame-review')) throw new Error('The production flow did not complete all expected stages.');
    const history=requireOK(await engine.invoke('studio:history'));
    const reopened=requireOK(await engine.invoke('studio:historyGet',{id:entry.id})).entry;
    if (history.entries.length!==1 || reopened.videoUrl!==video.videoUrl) throw new Error('History did not retain the generated result.');
    const videoPath=await engine.resolveMedia(video.videoUrl);
    const ffprobe=path.join(path.dirname(env.ffmpeg.ffmpeg),'ffprobe');
    const probe=file=>JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{encoding:'utf8',timeout:20000}));
    const media=probe(videoPath);
    const visual=media.streams.find(x=>x.codec_type==='video'), sound=media.streams.find(x=>x.codec_type==='audio');
    if (visual?.codec_name!=='h264'||sound?.codec_name!=='aac'||Number(visual.nb_frames)!==video.videoMeta.frames) throw new Error('MP4 codec, audio, or frame-count verification failed.');

    // Seed imported fixture clips only in this isolated CLI data root. The
    // production prepare/save/export handlers and real FFmpeg remain in use;
    // no video service, Keychain credential or paid request is involved.
    const prepared=requireOK(await engine.invoke('studio:imageVideoPrepare',{id:entry.id})).entry;
    if(prepared.imageVideo.shots.length!==16 || prepared.imageVideo.shots.filter(shot=>shot.enabled).length!==12) throw new Error('Board scene preparation failed.');
    requireOK(await engine.invoke('studio:imageVideoSavePlan',{id:entry.id,...prepared.imageVideo,
      shots:prepared.imageVideo.shots.map((shot,index)=>({...shot,enabled:index<2,duration:1}))}));
    const fixtureStore=createStore(userData), saved=(await fixtureStore.readHistory()).find(item=>item.id===entry.id);
    const clipProbe=await createImageVideoMedia({sourceRoot}).probeClip(videoPath);
    for(const shot of saved.imageVideo.shots.filter(shot=>shot.enabled)) {
      const clipPath=path.join(fixtureStore.videoDirFor(entry.id),'image-video','verification-imports',shot.id+'.mp4');
      await fs.mkdir(path.dirname(clipPath),{recursive:true}); await fs.copyFile(videoPath,clipPath);
      Object.assign(shot,{clipPath,clipMeta:clipProbe,status:'succeeded',imported:true});
    }
    await fixtureStore.updateEntry(entry.id,{imageVideo:saved.imageVideo});
    const imageVideo=requireOK(await engine.invoke('studio:imageVideoExport',{id:entry.id,options:{aspectRatio:'16:9',quality:'draft',musicSource:'none'}})).entry;
    const imageVideoPath=await engine.resolveMedia(imageVideo.imageVideo.output.videoUrl), imageProbe=probe(imageVideoPath);
    const imageStream=imageProbe.streams.find(item=>item.codec_type==='video');
    if(!imageVideo.hasImageVideo || imageVideo.videoUrl!==video.videoUrl || imageVideo.imageVideo.output.videoUrl===video.videoUrl
      || imageStream.codec_name!=='h264' || Math.abs(Number(imageProbe.format.duration)-2)>0.1) throw new Error('Separate image-video export failed.');

    const renderer=createRenderer({sourceRoot,nativeCall});
    const ratioChecks=[];
    const sizes = fullSize ? [['1:1',1440,1440],['16:9',1920,1080],['9:16',1080,1920]] : [['1:1',640,640],['16:9',960,540],['9:16',540,960]];
    for (const [aspect,W,H] of sizes) {
      const timing={W,H,T:8,fps:60,bpm:120,beat:0.5,bars:4,title:'Local original engine',scenes:[]};
      const normalized=direction.normalizeScript(script,{T:8,beat:0.5}).script;
      const file=path.join(output,aspect.replace(':','-')+'.html'); await fs.writeFile(file,direction.buildEngineShell({script:normalized,timing}));
      const page=await renderer.openPage(file,{W,H});
      try {
        if(!page.ready||page.errors().length) throw new Error('Original engine initialization failed.');
        const first=await page.capture(0.65), loop=await page.capture(8.65), changed=await page.capture(3.25);
        if(!first.equals(loop)||first.equals(changed)) throw new Error('Original engine seek/loop determinism failed.');
        await fs.writeFile(path.join(output,aspect.replace(':','-')+'.png'),first);
        ratioChecks.push({aspect,W,H,loopIdentical:true,changedPhase:true});
      } finally {await page.close();}
    }
    const freeTiming={W:320,H:180,T:1,fps:60,bpm:120,beat:0.5,bars:0.5,title:'Free code fixture',scenes:[]};
    const freeFile=path.join(output,'free-code.html'); await fs.writeFile(freeFile,compose.buildShell({parts:compose.parseCompose(code),timing:freeTiming}));
    const checked=await renderer.validate(freeFile,freeTiming);
    if(!checked.ok) throw new Error(checked.problems.join('; '));
    const finalFile=path.join(output,'free-code-60fps.mp4');
    const final=await renderer.renderVideo(freeFile,freeTiming,{outFile:finalFile,quality:'final',workers:1});
    const finalStream=probe(finalFile).streams.find(x=>x.codec_type==='video');
    if(final.frames!==60||final.subframes!==4||Number(finalStream.nb_frames)!==60) throw new Error('60fps four-sample rendering failed.');
    const hashBefore=crypto.createHash('sha256').update(await fs.readFile(finalFile)).digest('hex');
    const abort=new AbortController(); let cancelled=false;
    try {await renderer.renderVideo(freeFile,freeTiming,{outFile:finalFile,quality:'draft',workers:1,signal:abort.signal,onProgress:({done})=>{if(done>=1) abort.abort();}});}
    catch(error){if(error.code==='CANCELLED'||abort.signal.aborted) cancelled=true; else throw error;}
    const hashAfter=crypto.createHash('sha256').update(await fs.readFile(finalFile)).digest('hex');
    if(!cancelled||hashBefore!==hashAfter) throw new Error('Cancellation did not preserve the existing video.');
    await renderer.shutdown();
    const receipt={ok:true,offline:true,fullSize,providerCallsAreFixtures:true,actualProviderLoginTested:false,
      runtime:{node:process.execPath,ffmpeg:env.ffmpeg.ffmpeg,ffprobe,h264Encoder:process.env.MOTION_BOARD_H264_ENCODER||'libx264'},
      phases,originalWorkflow:true,historyRoundTrip:true,boardAttachment:true,musicAnalysisAndMixing:true,
      video:{width:visual.width,height:visual.height,fps:video.videoMeta.fps,frames:Number(visual.nb_frames),seconds:Number(media.format.duration),audio:sound.codec_name,bpm:video.videoMeta.bpm},
      imageVideo:{sceneCount:16,initialSelected:12,exportedScenes:2,importedClipsAreFixtures:true,realProviderGenerationTested:false,
        width:imageStream.width,height:imageStream.height,seconds:Number(imageProbe.format.duration),motionOutputPreserved:true},
      ratios:ratioChecks,freeCode:{frames:final.frames,fps:final.fps,subframes:final.subframes},cancellationPreservesExistingVideo:true};
    await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    return {...receipt,outputDirectory:output};
  }
  return {injections,run};
}
module.exports={createVerification};
