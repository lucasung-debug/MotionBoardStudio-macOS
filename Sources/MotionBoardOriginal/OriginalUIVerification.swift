import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
@preconcurrency import WebKit

/// Exercises the Mac frontend and preserved motion flow with the native bridge. Its
/// coordinator installs only the CLI verification providers and transient data.
@MainActor
enum OriginalUIVerification {
    static func run(dataRoot: URL, output: URL) async throws -> JSONValue {
        let screenshot = output.appendingPathComponent("native-ui.png")
        let imageVideoScreenshot = output.appendingPathComponent("native-image-video.png")
        let requestScreenshot = output.appendingPathComponent("native-request-status.png")
        let receiptFile = output.appendingPathComponent("native-ui-receipt.json")
        guard !FileManager.default.fileExists(atPath: screenshot.path),
              !FileManager.default.fileExists(atPath: imageVideoScreenshot.path),
              !FileManager.default.fileExists(atPath: requestScreenshot.path),
              !FileManager.default.fileExists(atPath: receiptFile.path) else {
            throw StudioError("Native UI verification artifacts already exist; choose another output directory.")
        }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let coordinator = StudioCoordinator(dataRoot: dataRoot, verification: true)
        let web = coordinator.makeWebView()
        let bounds = NSRect(x: 0, y: 0, width: 1380, height: 900)
        let window = OriginalUIVerificationWindow(contentRect: bounds, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "모션보드 스튜디오 · 로컬 검증"
        window.isReleasedWhenClosed = false
        window.contentView = web
        web.frame = bounds
        web.autoresizingMask = [.width, .height]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        coordinator.start()
        defer {
            coordinator.shutdown()
            web.stopLoading()
            web.configuration.userContentController.removeScriptMessageHandler(forName: "studio", contentWorld: .page)
            window.orderOut(nil)
            window.close()
        }

        do {
            try await waitFor(web, coordinator: coordinator, label: "original frontend initialization", timeout: 45, expression: """
            document.readyState === 'complete' && typeof envInfo !== 'undefined' && envInfo?.ok === true
              && typeof authState !== 'undefined' && authState.loggedIn === true
              && typeof claudeState !== 'undefined' && claudeState.loggedIn === true
              && document.querySelectorAll('#historyList .history-item').length > 0
              && document.getElementById('ffmpegHint')?.textContent.includes('이 Mac')
            """)

            let bridge = try await javascript(web, body: """
            const expected = ['env','guide','auth.status','auth.login','auth.logout','claude.status','claude.loginStart',
              'claude.loginComplete','claude.loginCancel','claude.logout','spec','board','video','pickMusic','installFfmpeg',
              'videoSaveAs','videoReveal','cancel','history','historyGet','historyRemove','imageSaveAs','imageImport',
              'reveal','openDataDir','openExternal', 'imageVideo.providers','imageVideo.configure','imageVideo.disconnect',
              'imageVideo.prepare','imageVideo.savePlan','imageVideo.generate','imageVideo.refresh','imageVideo.recover','imageVideo.importClip','imageVideo.export'];
            const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
              const path = prefix ? `${prefix}.${key}` : key;
              return typeof item === 'function' ? [path] : item && typeof item === 'object' ? flatten(item, path) : [];
            });
            const functions = flatten(window.studio);
            const events = functions.filter(name => /^on[A-Z]/.test(name));
            const calls = functions.filter(name => !events.includes(name));
            if (JSON.stringify(calls.sort()) !== JSON.stringify(expected.sort())) throw new Error('Original and image-video method facade mismatch.');
            if (JSON.stringify(events.sort()) !== JSON.stringify(['onAuth','onClaudeAuth','onProgress'])) throw new Error('Original event facade mismatch.');
            const environment = await window.studio.env();
            const history = await window.studio.history();
            if (!environment.ok || !environment.ffmpeg || !history.ok || !history.entries.length) throw new Error('Main-frame env/history bridge failed.');
            if (typeof environment.model !== 'string' || !environment.model || typeof environment.claudeModel !== 'string' || !environment.claudeModel
              || document.getElementById('modelBadge').textContent.includes('undefined')) throw new Error('Environment model labels are missing.');
            const count = document.querySelectorAll('#historyList .history-item').length;
            if (count !== history.entries.length || Number(document.getElementById('historyCount').textContent) !== count) throw new Error('History DOM does not match stored entries.');
            const hint = document.getElementById('ffmpegHint').textContent;
            const button = document.getElementById('installFfmpegBtn');
            if (!hint.includes('이 Mac') || hint.includes('이 PC') || !button.textContent.includes('연결 / 설치 안내')) throw new Error('macOS FFmpeg adaptation was not applied.');
            return {methodCount:calls.length, subscriptionCount:events.length, mainFrameEnv:true, mainFrameHistory:true,
              historyCount:count, ffmpegAvailable:true, ffmpegHint:hint, ffmpegButtonHidden:button.hidden,
              documentTitle:document.title, authenticationMode:'offline-fixture'};
            """)

            _ = try await javascript(web, body: """
            document.querySelector('[data-tab="history"]').click();
            const button = [...document.querySelectorAll('#historyList .history-item:first-child .history-actions button')]
              .find(button => button.textContent.trim() === '열기');
            if (!button) throw new Error('Original history Open button is missing.');
            button.click();
            return true;
            """)
            try await waitFor(web, coordinator: coordinator, label: "history Open button", expression: """
            typeof current !== 'undefined' && current?.hasVideo && current?.imageUrl
              && !document.getElementById('conceptView').hidden
              && document.getElementById('resultTitle').textContent === current.title
              && document.getElementById('statusText').textContent.startsWith('기록 불러옴')
            """)

            _ = try await javascript(web, body: "document.querySelector('[data-tab=\"image\"]').click(); return true;")
            try await waitFor(web, coordinator: coordinator, label: "studio-image board", expression: """
            document.getElementById('boardImage').complete && document.getElementById('boardImage').naturalWidth > 0
              && document.getElementById('boardImage').currentSrc.startsWith('studio-image://local/')
            """)
            let board = try await javascript(web, body: """
            const image = document.getElementById('boardImage');
            if (document.getElementById('imageView').hidden || !document.getElementById('yamlPre').textContent.trim()) throw new Error('Original board or YAML view is empty.');
            return {historyOpenButton:true, loaded:true, width:image.naturalWidth, height:image.naturalHeight,
              sourceScheme:new URL(image.currentSrc).protocol, yamlPopulated:true, conceptPopulated:Boolean(document.getElementById('conceptText').textContent.trim())};
            """)

            let forms = try await javascript(web, body: """
            const required = [...FORM_FIELDS, ...FORM_CHECKS, 'runBtn','cancelBtn','conceptView','yamlPre','boardImage',
              'videoPlayer','videoNotes','historyList','historyCount'];
            const missing = required.filter(id => !document.getElementById(id));
            if (missing.length) throw new Error(`Missing original controls: ${missing.join(', ')}`);
            const fieldIDs = ['provider','musicSource','engine','quality','duration','topic'];
            const saved = Object.fromEntries(fieldIDs.map(id => [id,document.getElementById(id).value]));
            const videoWasChecked = document.getElementById('withVideo').checked;
            const change = (id,value) => {const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));};
            let result;
            try {
              change('provider','claude');
              const claudeChoice = !document.getElementById('withImageRow').hidden && document.getElementById('modelBadge').textContent.includes(envInfo.claudeModel);
              change('musicSource','file');
              const musicChoice = !document.getElementById('musicFileRow').hidden;
              document.getElementById('withVideo').click();
              const toggleWorks = document.getElementById('videoOptions').hidden === !document.getElementById('withVideo').checked;
              change('engine','code'); change('quality','draft'); change('duration','19'); change('topic','로컬 UI 검증');
              const input = collectInput();
              if (!claudeChoice || !musicChoice || !toggleWorks || input.engine !== 'code' || input.quality !== 'draft'
                || input.durationSeconds !== 19 || input.topic !== '로컬 UI 검증') throw new Error('Original form change handlers did not update the UI/input.');
              const duration = document.getElementById('duration');
              if (duration.min !== '5' || duration.max !== '120') throw new Error('Original duration range changed.');
              result = {missingControls:missing, providerChoice:true, musicChoice:true, videoToggle:true,
                collectedInput:true, durationMinimum:Number(duration.min), durationMaximum:Number(duration.max)};
            } finally {
              for (const [id,value] of Object.entries(saved)) change(id,value);
              if (document.getElementById('withVideo').checked !== videoWasChecked) document.getElementById('withVideo').click();
            }
            const tabs = ['concept','yaml','image','video','history'];
            for (const name of tabs) {
              document.querySelector(`[data-tab="${name}"]`).click();
              const active = document.querySelectorAll('.tab.active'), body = document.querySelectorAll('.tab-body.active');
              if (active.length !== 1 || body.length !== 1 || active[0].dataset.tab !== name || body[0].dataset.body !== name
                || getComputedStyle(body[0]).display === 'none') throw new Error(`Original ${name} tab did not open.`);
            }
            document.querySelector('[data-tab="video"]').click();
            return {...result,tabs};
            """)

            try await waitFor(web, coordinator: coordinator, label: "studio-video metadata", timeout: 30, expression: """
            (() => { const video=document.getElementById('videoPlayer');
              if (video.error) throw new Error(`Video media error ${video.error.code}: ${video.error.message}`);
              return video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0
                && Number.isFinite(video.duration) && video.duration > 0 && video.currentSrc.startsWith('studio-video://local/');
            })()
            """)
            let playback = try await javascript(web, body: """
            const video = document.getElementById('videoPlayer');
            video.muted = true;
            const before = video.currentTime;
            const attempt = await Promise.race([
              Promise.resolve().then(() => video.play()).then(() => ({allowed:true})).catch(error => ({allowed:false,reason:`${error.name}: ${error.message}`})),
              new Promise(resolve => setTimeout(() => resolve({allowed:false,reason:'Playback request exceeded 3 seconds.'}),3000))
            ]);
            if (attempt.allowed) await new Promise(resolve => setTimeout(resolve,400));
            const advanced = video.currentTime > before + 0.05;
            video.pause();
            return {...attempt,attempted:true,advanced,mutedForVerification:true};
            """)
            _ = try await javascript(web, body: """
            const video = document.getElementById('videoPlayer');
            video.pause();
            video.currentTime = Math.min(1,video.duration/2);
            return true;
            """)
            try await waitFor(web, coordinator: coordinator, label: "video seek and decoded frame", timeout: 20, expression: """
            (() => { const video=document.getElementById('videoPlayer');
              if (video.error) throw new Error(`Video media error ${video.error.code}: ${video.error.message}`);
              return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime-Math.min(1,video.duration/2)) < 0.1;
            })()
            """)
            let video = try await javascript(web, body: """
            const player = document.getElementById('videoPlayer'), expected = current.videoMeta || {};
            const sceneCount = expected.direction?.shots?.length || 0;
            const sceneSummary = [...document.querySelectorAll('#videoNotes li')].some(item => item.textContent.includes(`장면 ${sceneCount}개`));
            if (player.videoWidth !== expected.width || player.videoHeight !== expected.height
              || Math.abs(player.duration-expected.T) > Math.max(0.1,2/(expected.fps || 30))) throw new Error('Video metadata differs from the stored result.');
            if (sceneCount && !sceneSummary) throw new Error('Original scene summary was not displayed.');
            const quality = typeof player.getVideoPlaybackQuality === 'function' ? player.getVideoPlaybackQuality() : null;
            return {loadedMetadata:true, decodedFrameAvailable:player.readyState >= 2, sourceScheme:new URL(player.currentSrc).protocol,
              width:player.videoWidth,height:player.videoHeight,duration:player.duration,currentTime:player.currentTime,
              paused:player.paused,seekCompleted:!player.seeking,expectedDuration:expected.T,sceneCount,sceneSummaryPresent:sceneSummary,
              totalVideoFrames:quality?.totalVideoFrames ?? null,readyState:player.readyState};
            """)

            let iframe = try await javascript(web, body: """
            const frame = document.createElement('iframe');
            frame.hidden = true;
            document.body.appendChild(frame);
            try {
              await new Promise(resolve => setTimeout(resolve,100));
              let handler;
              try { handler = frame.contentWindow?.webkit?.messageHandlers?.studio; }
              catch (error) { return {requestAttempted:false,handlerAccessible:false,nativeGuardVerified:false,limitation:`Subframe handler inaccessible: ${error.name}`}; }
              if (!handler) return {requestAttempted:false,handlerAccessible:false,nativeGuardVerified:false,limitation:'No native handler is exposed to the empty subframe.'};
              const response = await handler.postMessage({method:'studio:env',params:null});
              if (response?.ok !== false) throw new Error('A subframe accessed the native studio bridge.');
              return {requestAttempted:true,handlerAccessible:true,nativeGuardVerified:true,rejected:true};
            } finally { frame.remove(); }
            """)

            _ = try await javascript(web, body: """
            document.querySelector('[data-tab="video"]').click();
            window.scrollTo(0,0);
            await document.fonts.ready;
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {width:innerWidth,height:innerHeight};
            """)
            let capture = try await saveSnapshot(web, window: window, to: screenshot)
            let specificationControls = try await javascript(web, body: """
            window.__specVerificationSaved = {provider:document.getElementById('provider').value,
              effort:document.getElementById('claudeEffort').value};
            const choose=(id,value)=>{const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));};
            choose('provider','claude'); choose('claudeEffort','high');
            if (collectInput().claudeEffort!=='high' || document.getElementById('claudeEffortRow').hidden
              || !document.getElementById('modelBadge').textContent.includes('깊게')) throw new Error('Claude speed selection was not applied.');
            choose('claudeEffort','medium');
            if (collectInput().claudeEffort!=='medium' || !document.getElementById('claudeEffortHint').textContent.includes('5분'))
              throw new Error('Balanced specification setting is missing.');
            setBusy(true);
            handleProgress({phase:'spec_wait',state:'waiting',elapsedSeconds:125,lastActivitySeconds:1,textCharacters:0,heartbeatCount:10});
            if (document.getElementById('statusText').textContent.includes('검토') || document.getElementById('requestDetail').hidden
              || !document.getElementById('requestDetail').textContent.includes('2분 5초')) throw new Error('Waiting was mislabeled as model thinking.');
            handleProgress({phase:'spec_wait',state:'thinking',elapsedSeconds:126,lastActivitySeconds:0,textCharacters:0});
            if (!document.getElementById('statusText').textContent.includes('검토') || !document.getElementById('claudeEffort').disabled
              || document.getElementById('cancelBtn').disabled) throw new Error('Thinking status or cancellation controls are incorrect.');
            window.scrollTo(0,0);
            document.querySelector('.form-panel').scrollTop=document.querySelector('.form-panel').scrollHeight;
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            return {selectedEffort:'medium',selectedModel:envInfo.claudeModel,choiceApplied:true,waitingIsNotThinking:true,
              elapsedVisible:true,cancellationAvailable:true,syntheticActivity:true};
            """)
            let requestCapture = try await saveSnapshot(web, window: window, to: requestScreenshot)
            _ = try await javascript(web, body: """
            setBusy(false);
            document.getElementById('provider').value=window.__specVerificationSaved.provider;
            document.getElementById('claudeEffort').value=window.__specVerificationSaved.effort;
            delete window.__specVerificationSaved;
            updateModelBadge(); updateImageChoice();
            setStatus('로컬 UI 검증 완료');
            document.querySelector('.form-panel').scrollTop=0;
            if (!document.getElementById('requestDetail').hidden) throw new Error('Request activity remained after completion.');
            return true;
            """)
            let imageVideo = try await verifyImageVideo(web, coordinator: coordinator)
            let imageVideoCapture = try await saveSnapshot(web, window: window, to: imageVideoScreenshot)
            var limitations: [JSONValue] = [.string("Provider responses and account status were offline fixtures; no real login or AI generation was tested.")]
            limitations.append(.string("Image-video clips were local copies of the motion fixture; board crops and the separate two-second composition used real media. Subject animation from Grok or Kling was not tested."))
            if playback["allowed"].boolValue != true || playback["advanced"].boolValue != true {
                limitations.append(.string("Programmatic playback did not advance; metadata, decoding, and seek were verified separately."))
            }
            if iframe["nativeGuardVerified"].boolValue != true {
                limitations.append(.string(iframe["limitation"].stringValue ?? "A subframe native request could not be dispatched."))
            }
            let receipt: JSONValue = .object([
                "ok": .bool(true), "macFrontend": .bool(true), "originalMotionFlowPreserved": .bool(true), "productionNativeBridge": .bool(true),
                "nonPersistentWebData": .bool(true), "realProviderLoginTested": .bool(false),
                "bridge": bridge, "board": board, "forms": forms, "video": video,
                "playback": playback, "subframe": iframe, "screenshot": capture,
                "specificationControls": specificationControls, "requestScreenshot": requestCapture,
                "imageVideo": imageVideo, "imageVideoScreenshot": imageVideoCapture,
                "limitations": .array(limitations)
            ])
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(receipt).write(to: receiptFile, options: .withoutOverwriting)
            return receipt
        } catch {
            let failureImage = output.appendingPathComponent("native-ui-failure.png")
            if !FileManager.default.fileExists(atPath: failureImage.path) {
                _ = try? await saveSnapshot(web, window: window, to: failureImage)
            }
            throw error
        }
    }

    private static func verifyImageVideo(_ web: WKWebView, coordinator: StudioCoordinator) async throws -> JSONValue {
        try await waitFor(web, coordinator: coordinator, label: "image-video fixture and provider catalog", expression: """
        current?.imageVideo?.shots?.length === 16 && current.imageVideo.output?.videoUrl
          && imageProviders.some(provider => provider.id === 'grok') && imageProviders.some(provider => provider.id === 'kling')
        """)
        return try await javascript(web, body: """
        const delay = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
        const until = async (test,label) => {
          const deadline=Date.now()+20000;
          while (Date.now()<deadline) { if (test()) return; await delay(50); }
          throw new Error(`Timed out waiting for ${label}.`);
        };
        const radios=[...document.querySelectorAll('input[name="creationMode"]')];
        if (radios.length!==2 || !radios.some(radio=>radio.value==='motion_graphics') || !radios.some(radio=>radio.value==='image_video'))
          throw new Error('The two creation choices are missing.');
        const secretFields=[...document.querySelectorAll('input,textarea')].filter(field=>field.type==='password'
          || /api.?key|access.?key|secret.?key|api.?token/i.test(`${field.id} ${field.name}`));
        if (secretFields.length) throw new Error('Video service credential fields must remain outside the web page.');
        const imageRadio=radios.find(radio=>radio.value==='image_video'), motionRadio=radios.find(radio=>radio.value==='motion_graphics');
        imageRadio.click();
        const imageInput=collectInput(), imageCTA=document.getElementById('runBtn').textContent;
        if (creationMode!=='image_video' || imageInput.withVideo!==false || imageInput.withImage!==true
          || !document.getElementById('motionVideoOptions').hidden || document.getElementById('imageCreationNote').hidden)
          throw new Error('Image creation mode did not preserve the separate board-first flow.');
        motionRadio.click();
        const motionCTA=document.getElementById('runBtn').textContent;
        if (creationMode!=='motion_graphics' || document.getElementById('motionVideoOptions').hidden
          || !document.getElementById('imageCreationNote').hidden || motionCTA===imageCTA)
          throw new Error('Motion creation mode did not restore its original controls.');
        imageRadio.click();
        const panel=document.querySelector('[data-body="image-video"]');
        if (!panel.classList.contains('active') || getComputedStyle(panel).display==='none'
          || document.getElementById('imageVideoWorkbench').hidden) throw new Error('The image-video workbench did not open.');
        const cards=[...document.querySelectorAll('#sceneGrid .scene-card')];
        const included=cards.map(card=>card.querySelector('.scene-check input[type="checkbox"]')?.checked);
        if (cards.length!==16 || included.some((checked,index)=>checked!==(index<2))) throw new Error('The 16 board cells or two selected fixtures are incorrect.');
        if (new Set(current.imageVideo.shots.map(shot=>shot.imageUrl)).size!==16
          || current.imageVideo.shots.slice(0,2).some(shot=>!shot.imported || shot.status!=='succeeded' || Number(shot.duration)!==1 || !shot.videoUrl))
          throw new Error('The separate imported clip fixtures were not restored.');
        const providerSelect=document.getElementById('imageVideoProvider');
        const providerIDs=[...providerSelect.options].map(option=>option.value);
        if (!providerIDs.includes('grok') || !providerIDs.includes('kling') || providerSelect.disabled) throw new Error('Grok and Kling provider choices are unavailable.');

        // Observe the actual bridge boundary. The env canary proves that the
        // observer is active; every other call is blocked during the UI edit.
        const handler=window.webkit.messageHandlers.studio;
        const originalPost=handler.postMessage, ownPost=Object.getOwnPropertyDescriptor(handler,'postMessage');
        const calls=[];
        let canary=true, providerChange;
        const observed=function(message) {
          calls.push(String(message?.method || 'unknown'));
          if (canary && message?.method==='studio:env') return originalPost.call(handler,message);
          return Promise.resolve({ok:false,code:'UI_VERIFICATION_NO_REQUEST',error:'UI verification blocked an unexpected request.'});
        };
        const storedBefore=JSON.stringify(current.imageVideo), originalProvider=imageDraft.provider;
        const importedBefore=imageDraft.shots.filter(shot=>shot.imported).map(shot=>shot.duration);
        try {
          Object.defineProperty(handler,'postMessage',{configurable:true,writable:true,value:observed});
          const environment=await window.studio.env();
          if (!environment.ok || calls.length!==1 || calls[0]!=='studio:env') throw new Error('Provider-change bridge observer could not be verified.');
          canary=false; calls.length=0;
          const next=providerIDs.find(id=>id!==originalProvider);
          providerSelect.value=next;
          providerSelect.dispatchEvent(new Event('change',{bubbles:true}));
          await delay(250);
          if (calls.length) throw new Error(`Provider selection dispatched requests: ${calls.join(', ')}.`);
          if (imageDraft.provider!==next || !imageDraftDirty || JSON.stringify(current.imageVideo)!==storedBefore
            || !document.getElementById('sceneSaveStatus').textContent.includes('저장하지 않은')) throw new Error('Provider selection did not remain an unsaved local edit.');
          if (JSON.stringify(imageDraft.shots.filter(shot=>shot.imported).map(shot=>shot.duration))!==JSON.stringify(importedBefore))
            throw new Error('Provider selection changed imported clip durations.');
          providerChange={from:originalProvider,to:next,bridgeObserverCanary:true,nativeRequests:0,unsavedLocalEdit:true,importedDurationsPreserved:true};
        } finally {
          if (ownPost) Object.defineProperty(handler,'postMessage',ownPost); else delete handler.postMessage;
          imageDraftDirty=false;
          renderImageVideo(current);
        }

        const mediaCheck=async (id,expected) => {
          const player=document.getElementById(id);
          await until(()=>{
            if (player.error) throw new Error(`${id} media error ${player.error.code}: ${player.error.message}`);
            return player.currentSrc===expected.url && player.readyState>=1 && player.videoWidth>0 && player.videoHeight>0 && Number.isFinite(player.duration) && player.duration>0;
          },`${id} metadata`);
          if (!player.currentSrc.startsWith('studio-video://local/') || player.videoWidth!==expected.width || player.videoHeight!==expected.height
            || Math.abs(player.duration-expected.duration)>Math.max(0.1,2/(expected.fps || 30))) throw new Error(`${id} metadata differs from the stored media.`);
          player.muted=true;
          const before=player.currentTime;
          const play=await Promise.race([
            Promise.resolve().then(()=>player.play()).then(()=>({allowed:true})).catch(error=>({allowed:false,reason:`${error.name}: ${error.message}`})),
            delay(3000).then(()=>({allowed:false,reason:'Playback request exceeded 3 seconds.'}))
          ]);
          if (play.allowed) await delay(250);
          const advanced=player.currentTime>before+0.05;
          player.pause(); player.currentTime=Math.min(0.5,player.duration/2);
          await until(()=>{
            if (player.error) throw new Error(`${id} decode error ${player.error.code}.`);
            return !player.seeking && player.readyState>=2 && Math.abs(player.currentTime-Math.min(0.5,player.duration/2))<0.1;
          },`${id} decoded frame and seek`);
          return {loadedMetadata:true,decodedFrameAvailable:true,seekCompleted:true,sourceScheme:new URL(player.currentSrc).protocol,
            width:player.videoWidth,height:player.videoHeight,duration:player.duration,currentTime:player.currentTime,
            playback:{...play,advanced,mutedForVerification:true}};
        };
        const scenes=[];
        for (let index=0;index<2;index++) {
          document.querySelectorAll('#sceneGrid .scene-preview')[index].click();
          const shot=current.imageVideo.shots[index], source=document.getElementById('sceneSourceImage');
          await until(()=>source.complete && source.naturalWidth>0 && source.currentSrc===shot.imageUrl,`scene ${index+1} source image`);
          if (!source.currentSrc.startsWith('studio-image://local/') || Math.min(source.naturalWidth,source.naturalHeight)<512
            || Math.abs(source.naturalWidth/source.naturalHeight-shot.sourceWidth/shot.sourceHeight)>0.005)
            throw new Error(`Scene ${index+1} source crop dimensions are incorrect.`);
          const player=document.getElementById('sceneVideoPlayer');
          if (player.hidden || player.dataset.src!==shot.videoUrl || Number(document.getElementById('sceneDuration').value)!==1)
            throw new Error(`Scene ${index+1} did not display its imported one-second selection.`);
          const clip=await mediaCheck('sceneVideoPlayer',{url:shot.videoUrl,width:current.videoMeta.width,height:current.videoMeta.height,duration:current.videoMeta.T,fps:current.videoMeta.fps});
          scenes.push({index,imported:true,selectedDuration:1,source:{width:source.naturalWidth,height:source.naturalHeight,sourceScheme:new URL(source.currentSrc).protocol},clip});
        }
        const output=current.imageVideo.output, outputPlayer=document.getElementById('imageVideoPlayer'), meta=output.videoMeta;
        const outputDuration=Number(meta.duration || meta.T || meta.durationSeconds);
        if (output.videoUrl===current.videoUrl || outputPlayer.dataset.src!==output.videoUrl || document.getElementById('imageVideoOutput').hidden
          || document.getElementById('saveImageVideoBtn').disabled || document.getElementById('exportImageVideoBtn').disabled
          || !document.getElementById('generateScenesBtn').disabled || Math.abs(outputDuration-2)>0.1)
          throw new Error('Separate final image-video output or ready-clip actions are incorrect.');
        const finalVideo=await mediaCheck('imageVideoPlayer',{url:output.videoUrl,width:meta.width,height:meta.height,duration:outputDuration,fps:meta.fps});
        if (!document.getElementById('imageVideoMeta').textContent.includes(`${meta.width}×${meta.height}`)) throw new Error('Final image-video dimensions are not displayed.');
        const legacy=document.getElementById('videoPlayer'), legacyURL=new URL(legacy.currentSrc);
        legacyURL.search='';
        if (legacyURL.href!==current.videoUrl)
          throw new Error('Image-video viewing replaced the original motion video.');

        document.querySelector('#sceneGrid .scene-preview').click();
        const thumbnails=[...document.querySelectorAll('#sceneGrid .scene-preview img')];
        thumbnails.forEach(image=>{image.loading='eager';});
        await until(()=>thumbnails.length===16 && thumbnails.every(image=>image.complete && image.naturalWidth>0),'all 16 board thumbnails');
        const firstSource=document.getElementById('sceneSourceImage'), firstClip=document.getElementById('sceneVideoPlayer');
        await until(()=>firstSource.complete && firstSource.naturalWidth>0 && firstSource.currentSrc===current.imageVideo.shots[0].imageUrl
          && firstClip.currentSrc===current.imageVideo.shots[0].videoUrl && firstClip.readyState>=1,'first scene screenshot media');
        firstClip.pause(); firstClip.currentTime=Math.min(0.5,firstClip.duration/2);
        await until(()=>!firstClip.seeking && firstClip.readyState>=2,'first scene screenshot frame');
        window.scrollTo(0,0);
        await document.fonts.ready;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return {creationModes:['motion_graphics','image_video'],creationCTAs:{motion:motionCTA,image:imageCTA},secretFields:0,
          providerIDs,providerChange,sceneCount:16,selectedScenes:2,loadedThumbnails:16,scenes,
          finalVideo:{...finalVideo,separateFromMotion:true,selectedDuration:2},originalMotionVideoPreserved:true,
          importedClipsAreFixtures:true,realProviderGenerationTested:false};
        """, timeout: 90)
    }

    private static func waitFor(_ web: WKWebView, coordinator: StudioCoordinator, label: String,
                                timeout: Double = 20, expression: String) async throws {
        let deadline = ContinuousClock.now + .seconds(timeout)
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            if let failure = coordinator.failure { throw StudioError("\(label): \(failure)") }
            if coordinator.ready, !web.isLoading, web.url != nil {
                let result = try await javascript(web, body: "return Boolean(\(expression));")
                if result.boolValue == true { return }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        let state = try? await javascript(web, body: """
        const video=document.getElementById('videoPlayer');
        return {readyState:document.readyState,historyCount:document.getElementById('historyCount')?.textContent,
          status:document.getElementById('statusText')?.textContent,ffmpegHint:document.getElementById('ffmpegHint')?.textContent,
          videoReadyState:video?.readyState,videoError:video?.error?.message};
        """)
        throw StudioError("Timed out waiting for \(label). \((try? state?.encodedString()) ?? "No page state available.")")
    }

    private static func javascript(_ web: WKWebView, body: String, timeout: Double = 15) async throws -> JSONValue {
        let gate = OriginalUIReply<String>(timeout: timeout)
        let source = "const result = await (async () => {\n\(body)\n})(); return JSON.stringify(result === undefined ? null : result);"
        let encoded = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.start(continuation)
                web.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value):
                        if let text = value as? String { gate.finish(.success(text)) }
                        else { gate.finish(.failure(StudioError("UI verification did not return JSON."))) }
                    case .failure(let error): gate.finish(.failure(error))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in gate.finish(.failure(CancellationError())) }
        }
        return try JSONDecoder().decode(JSONValue.self, from: Data(encoded.utf8))
    }

    private static func saveSnapshot(_ web: WKWebView, window: NSWindow, to file: URL) async throws -> JSONValue {
        let width = 1380, height = 900
        guard Int(web.bounds.width) == width, Int(web.bounds.height) == height else {
            throw StudioError("Original UI viewport did not retain 1380×900 dimensions.")
        }
        web.layoutSubtreeIfNeeded()
        let configuration = WKSnapshotConfiguration()
        configuration.rect = web.bounds
        configuration.snapshotWidth = NSNumber(value: Double(width) / max(1, window.backingScaleFactor))
        configuration.afterScreenUpdates = true
        let gate = OriginalUIReply<CGImage>(timeout: 20)
        let image = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                gate.start(continuation)
                web.takeSnapshot(with: configuration) { image, error in
                    if let error { gate.finish(.failure(error)); return }
                    guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
                        gate.finish(.failure(StudioError("WebKit did not return the original UI snapshot."))); return
                    }
                    gate.finish(.success(cg))
                }
            }
        } onCancel: {
            Task { @MainActor in gate.finish(.failure(CancellationError())) }
        }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
            throw StudioError("Could not allocate the native UI snapshot.")
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let exact = context.makeImage(), let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else {
            throw StudioError("Could not inspect the native UI snapshot.")
        }
        var sum = 0.0, squared = 0.0, count = 0.0
        for pixel in stride(from: 0, to: width * height, by: max(1, width * height / 20_000)) {
            let offset = pixel * 4
            let value = 0.2126 * Double(bytes[offset]) + 0.7152 * Double(bytes[offset + 1]) + 0.0722 * Double(bytes[offset + 2])
            sum += value; squared += value * value; count += 1
        }
        let spread = sqrt(max(0, squared / count - pow(sum / count, 2)))
        guard spread > 2 else { throw StudioError("The native UI snapshot is blank or nearly uniform.") }
        let png = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else {
            throw StudioError("Could not encode the native UI snapshot.")
        }
        CGImageDestinationAddImage(destination, exact, nil)
        guard CGImageDestinationFinalize(destination) else { throw StudioError("Native UI PNG encoding failed.") }
        try (png as Data).write(to: file, options: .withoutOverwriting)
        return .object(["file": .string(file.lastPathComponent), "width": .number(Double(width)), "height": .number(Double(height)),
                        "luminanceSpread": .number(spread), "capture": .string("WKWebView DOM snapshot")])
    }
}

@MainActor
private final class OriginalUIVerificationWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor
private final class OriginalUIReply<Value: Sendable> {
    private let timeout: Double
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    private var timer: Task<Void, Never>?

    init(timeout: Double) { self.timeout = timeout }
    func start(_ continuation: CheckedContinuation<Value, Error>) {
        if let result { continuation.resume(with: result); return }
        self.continuation = continuation
        timer = Task { @MainActor [weak self] in
            guard let timeout = self?.timeout else { return }
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
            self?.finish(.failure(StudioError("Native UI operation exceeded \(Int(timeout)) seconds.")))
        }
    }
    func finish(_ result: Result<Value, Error>) {
        guard self.result == nil else { return }
        self.result = result
        timer?.cancel(); timer = nil
        continuation?.resume(with: result); continuation = nil
    }
}
