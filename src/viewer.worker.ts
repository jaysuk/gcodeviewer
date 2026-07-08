// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import Viewer from './viewer'

self.viewer = null //Main instance of the viewer.

self.addEventListener('message', async (message) => {
   //console.info('Message received from main thread', message.data)


   switch (message.data.type) {
      case 'init':
         self.window = {
            addEventListener: (event, fn, opt) => {
               self.viewer.bindHandler('window', event, fn, opt)
            },
            // Babylon's Engine.dispose() calls window/document.removeEventListener during its own
            // cleanup - without this it throws "removeEventListener is not a function" and aborts
            // the rest of dispose(). The worker is tearing down anyway at that point, so an actual
            // main-thread removal isn't needed, just something callable.
            removeEventListener: () => {},
            setTimeout: self.setTimeout.bind(self),
            PointerEvent: true,
         }

         self.document = {
            addEventListener: (event, fn, opt) => {
               self.viewer.bindHandler('document', event, fn, opt)
            },
            removeEventListener: () => {},
            // Babylon probes document.createElement for wheel support and uses it to create 2D canvases
            // for DynamicTexture, so canvas requests must return a real OffscreenCanvas
            createElement: function (tagName) {
               if (tagName === 'canvas') {
                  return new OffscreenCanvas(64, 64)
               }
               return { onwheel: true }
            },
            elementFromPoint: function () {
               return null
            },
            defaultView: self.window,
         }

         self.viewer = new Viewer()
         self.viewer.init_worker(message.data, self)
         self.viewer.initEngine()

         break
      case 'event': //UI Event
         self.viewer.handleEvent(message.data.type, message.data)
         break
      case 'resize': //Resize event was fired
         self.viewer.setSizes(message.data.width, message.data.height)
         break
      case 'loadFile':
         self.viewer.loadFile(message.data.file)
         break
      case 'clearScene':
         self.viewer.clear()
         break
      case 'reloadFile':
         self.viewer.reload()
         break
      case 'unload':
         self.viewer.unload()
         break
      case 'rendermode':
         self.viewer.processor.modelMaterial.forEach((m) => m.updateRenderMode(message.data.mode))
         break
      case 'updatefileposition':
         self.viewer.processor.updateFilePosition(message.data.position, message.data.animate || false)
         break
      case 'getgcodes':
         {
            await self.viewer.processor.getGCodeInRange(message.data.position, message.data.count)
         }
         break
      case 'gotolinenumber':
         self.viewer.processor.updateByLineNumber(message.data.lineNumber)
         break
      case 'setalphamode':
         self.viewer.processor.modelMaterial.forEach((m) => m.setAlphaMode(message.data.mode))
         break
      case 'setprogressmode':
         self.viewer.processor.modelMaterial.forEach((m) => m.setProgressMode(message.data.mode))
         break
      case 'setmeshmode':
         self.viewer.processor.setMeshMode(message.data.mode)
         break
      case 'setfps':
         self.viewer.setMaxFPS(message.data.fps)
         break
      case 'perimeterOnly':
         self.viewer.processor.setPerimeterOnly(message.data.perimeterOnly)
         break
      case 'toggleNozzle':
         {
            const nozzle = self.viewer.processor.getNozzle()
            if (nozzle) {
               if (message.data.visible) {
                  nozzle.show()
               } else {
                  nozzle.hide()
               }
            }
         }
         break
      case 'startNozzleAnimation':
         self.viewer.processor.startNozzleAnimation()
         break
      case 'pauseNozzleAnimation':
         self.viewer.processor.pauseNozzleAnimation()
         break
      case 'resumeNozzleAnimation':
         self.viewer.processor.resumeNozzleAnimation()
         break
      case 'stopNozzleAnimation':
         self.viewer.processor.stopNozzleAnimation()
         break
      case 'setNozzleAnimationSpeed':
         self.viewer.processor.setNozzleAnimationSpeed(message.data.speed)
         break
      case 'showViewBox':
         self.viewer.showViewBox(message.data.visible)
         break
      case 'setPickingEnabled':
         self.viewer.setPickingEnabled(message.data.enabled)
         break
      case 'setCameraDirection':
         self.viewer.setCameraDirection(message.data.direction)
         break
      case 'resetCamera':
         self.viewer.resetCamera()
         break
      case 'frameToContent':
         self.viewer.frameToContent(message.data.isEmbedded)
         break
      case 'setBackgroundColor':
         self.viewer.setBackgroundColor(message.data.color)
         break
      case 'setProgressColor':
         self.viewer.setProgressColor(message.data.color)
         break
      case 'setZBelt':
         self.viewer.setZBelt(message.data.enabled, message.data.angle)
         break
      case 'setG1AsExtrusion':
         self.viewer.setG1AsExtrusion(message.data.enabled)
         break
      case 'setCameraInertia':
         self.viewer.setCameraInertia(message.data.enabled)
         break
      case 'setZClipPlane':
         self.viewer.setZClipPlane(message.data.top, message.data.bottom)
         break
      case 'setTools':
         self.viewer.processor.setTools(message.data.tools)
         break
      case 'setBuildVolume':
         self.viewer.setBuildVolume(message.data.volume)
         break
      case 'setBedRenderMode':
         self.viewer.setBedRenderMode(message.data.mode)
         break
      case 'setBedColor':
         self.viewer.setBedColor(message.data.color)
         break
      case 'setDeltaBed':
         self.viewer.setDeltaBed(message.data.isDelta)
         break
      case 'showBed':
         self.viewer.showBed(message.data.visible)
         break
      case 'showAxes':
         self.viewer.showAxes(message.data.visible)
         break
      case 'showWorkplace':
         self.viewer.showWorkplace(message.data.visible)
         break
      case 'setWorkplaceOffsets':
         self.viewer.setWorkplaceOffsets(message.data.offsets)
         break
      case 'setCurrentWorkplaceIndex':
         self.viewer.setCurrentWorkplaceIndex(message.data.index)
         break
      case 'setNozzlePosition':
         self.viewer.setNozzlePosition(message.data.position)
         break
      case 'setShowTravels':
         self.viewer.setShowTravels(message.data.visible)
         break
      case 'setPersistTravels':
         self.viewer.setPersistTravels(message.data.persist)
         break
      case 'setFeedColors':
         self.viewer.setFeedColors(message.data.minColor, message.data.maxColor)
         break
      case 'setFeedRateRange':
         self.viewer.setFeedRateRange(message.data.min, message.data.max)
         break
      case 'cancelLoad':
         self.viewer.cancelLoad()
         break
      case 'loadObjectBoundaries':
         self.viewer.loadObjectBoundaries(message.data.objects)
         break
      case 'showObjectSelection':
         self.viewer.showObjectSelection(message.data.visible)
         break
      case 'showObjectLabels':
         self.viewer.showObjectLabels(message.data.visible)
         break
      case 'enableWasmProcessing':
         try {
            await self.viewer.processor.enableWasmProcessing()
            self.postMessage({ type: 'wasmInitialized', success: true })
         } catch (error) {
            self.postMessage({ 
               type: 'wasmInitialized', 
               success: false, 
               error: error.message 
            })
         }
         break
      case 'getProcessingStats':
         self.postMessage({ 
            type: 'processingStatsResponse', 
            stats: self.viewer.processor.getProcessingStats() 
         })
         break
   }
})
