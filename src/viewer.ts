import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { Color4, Color3 } from '@babylonjs/core/Maths/math.color'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { ArcRotateCameraKeyboardMoveInput } from '@babylonjs/core/Cameras/Inputs/arcRotateCameraKeyboardMoveInput'
import { Light } from '@babylonjs/core/Lights/light'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { FlyCamera } from '@babylonjs/core/Cameras/flyCamera'
import Processor from './processor'
import { EngineInstrumentation } from '@babylonjs/core/Instrumentation/engineInstrumentation'
import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import '@babylonjs/core/Engines/Extensions/engine.query'
import GPUPicker from './gpupicker'
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents'
import { Plane } from '@babylonjs/core/Maths/math.plane'
import ViewBox, { ViewBoxDirection } from './Renderables/viewbox'
import Bed, { BuildVolume, RenderBedMode } from './Renderables/bed'
import Axes from './Renderables/axes'
import BuildObjects from './Renderables/buildobjects'
import '@babylonjs/core/Rendering/'

export default class Viewer {
   scene: Scene | undefined
   engine: Engine | null = null
   orbitCamera: ArcRotateCamera | null = null
   flyCamera: FlyCamera | null = null
   offscreenCanvas: OffscreenCanvas | HTMLCanvasElement
   box: Mesh
   boxRotation: number
   light: Light
   pointLight: PointLight
   lastTimeStamp: number
   x: number = 1
   y: number = 1
   z: number = 1
   pause: boolean = false
   registeredEventHandlers = new Map<string, any>() //These are event handlers we want to bind to. Currently Canvas, Window, Document that we fake in the worker.
   worker: Worker
   processor: Processor = new Processor()
   viewBox: ViewBox | null = null
   bed: Bed | null = null
   axes: Axes | null = null
   buildObjects: BuildObjects | null = null
   zTopClipValue: number | null = null
   zBottomClipValue: number | null = null
   offscreen: boolean = true
   lastFrameUpdate: number = 0
   renderTimeout: number = 1000
   maxFrameRate = 1000 / 30

   // getBoundingInfo()
   rect = {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      height: 0,
      width: 0,
   }

   constructor() {}

   //Init message worker
   init_worker(data: any, worker: Worker) {
      this.offscreen = true
      this.offscreenCanvas = data.offscreencanvas

      this.offscreenCanvas.addEventListener = (event, fn, opt) => {
         this.bindHandler('canvas', event, fn, opt) //we do this to capture eventtargets
      }

      this.setSizes(data.width, data.height)

      //@ts-expect-error getBoundingClientRect is not defined on offscreen canvas but necessary for babylonjs
      this.offscreenCanvas.getBoundingClientRect = () => {
         return this.rect
      }

      //@ts-expect-error focus is not defined on offscreen canvas but necessary for babylonjs
      this.offscreenCanvas.focus = () => {
         this.worker.postMessage({
            type: 'canvasMethod',
            method: 'focus',
            args: [],
         })
      }

      this.worker = worker
   }

   init_direct(canvas: HTMLCanvasElement, fakeWorker) {
      this.offscreen = false
      this.offscreenCanvas = canvas
      this.worker = fakeWorker
   }

   setSizes(width, height) {
      if (this.offscreen) {
         //@ts-expect-error clientWidth is readonly on the canvas types but assignable on the faked worker-side canvas
         this.offscreenCanvas.clientWidth = width
         //@ts-expect-error clientHeight is readonly on the canvas types but assignable on the faked worker-side canvas
         this.offscreenCanvas.clientHeight = height
         this.offscreenCanvas.width = width
         this.offscreenCanvas.height = height

         this.rect.right = this.rect.width = width
         this.rect.bottom = this.rect.height = height
      }
      if (this.engine) {
         this.engine.resize()
         this.processor.gpuPicker.updateRenderTargetSize(this.engine.getRenderWidth(), this.engine.getRenderHeight())
      }
   }

   async initEngine() {
      console.info(`G-Code Viewer- Sindarius - 4 `)

      //this will use the offscreen rendering and web worker threads
      this.engine = new Engine(this.offscreenCanvas, true, {
         doNotHandleContextLost: true,
      }) //WebGPU does not currently have a constructor that takes offscreen canvas

      this.engine.enableOfflineSupport = false

      this.scene = new Scene(this.engine)

      this.scene.clearColor = new Color4(0.3, 0.3, 0.3, 1)
      //this.scene.useOrderIndependentTransparency = true
      //this.scene.depthPeelingRenderer.passCount = 2

      if (this.offscreen) {
         this.scene.doNotHandleCursors = true //We can't make cursor changes in the worker thread
      }
      //this.scene.performancePriority = ScenePerformancePriority.Intermediate //.Aggressive
      //this.scene.autoClear = true
      this.scene.skipPointerMovePicking = true

      this.processor.scene = this.scene
      this.processor.worker = this.worker
      this.processor.gpuPicker = new GPUPicker(
         this.scene,
         this.engine,
         this.offscreenCanvas.width,
         this.offscreenCanvas.height,
      )
      
      // Initialize nozzle
      this.processor.initNozzle(0.4)

      //Orbit Cam
      this.orbitCamera = new ArcRotateCamera('Camera', Math.PI / 2, 2.356194, 15, new Vector3(0, 0, 0), this.scene)
      this.orbitCamera.invertRotation = false
      this.orbitCamera.attachControl(this.offscreenCanvas, true)
      this.orbitCamera.maxZ = 100000
      this.orbitCamera.lowerRadiusLimit = 5
      this.orbitCamera.setPosition(new Vector3(150, 100, 0))
      this.orbitCamera.setTarget(new Vector3(150, 0, 150))

      //Cam properties
      this.orbitCamera.speed = 500
      this.orbitCamera.inertia = 0
      this.orbitCamera.panningInertia = 0
      const keyboardInput = this.orbitCamera.inputs.attached.keyboard as ArcRotateCameraKeyboardMoveInput
      keyboardInput.angularSpeed = 0.05
      keyboardInput.zoomingSensibility = 0.5
      keyboardInput.panningSensibility = 0.5
      this.orbitCamera.angularSensibilityX = 200
      this.orbitCamera.angularSensibilityY = 200
      this.orbitCamera.panningSensibility = 2
      this.orbitCamera.wheelPrecision = 0.25

      this.pointLight = new PointLight('pl', new Vector3(0, 1, -1), this.scene)

      this.pointLight.diffuse = new Color3(1, 1, 1)
      this.pointLight.specular = new Color3(1, 1, 1)

      this.bed = new Bed(this.scene)
      this.bed.registerClipIgnore = (mesh) => {
         this.registerClipIgnore(mesh)
      }
      this.bed.buildBed()

      this.axes = new Axes(this.scene)
      this.axes.registerClipIgnore = (mesh) => {
         this.registerClipIgnore(mesh)
      }
      this.axes.render()

      this.buildObjects = new BuildObjects(this.scene)
      this.buildObjects.getMaxHeight = () => {
         return this.processor.processorProperties.maxHeight
      }
      this.buildObjects.registerClipIgnore = (mesh) => {
         this.registerClipIgnore(mesh)
      }
      this.buildObjects.objectCallback = (metadata) => {
         this.worker.postMessage({ type: 'objectSelected', object: metadata })
      }
      this.buildObjects.labelCallback = (name) => {
         this.worker.postMessage({ type: 'objectLabel', name: name })
      }

      this.viewBox = new ViewBox(this.engine, this.orbitCamera)
      this.viewBox.onDirectionSelected = (direction) => {
         this.setCameraDirection(direction)
      }

      this.resetCamera()

      this.scene.render()

      //limit frames
      let deltaTime = 0
      this.engine.runRenderLoop(() => {
         if (document.hidden) return

         deltaTime += this.engine.getDeltaTime()
         if (deltaTime > this.maxFrameRate) {
            deltaTime = 0
         } else {
            return
         }

         this.pointLight.position = this.orbitCamera?.position ?? new Vector3(0, 0, 0)
         
         // Update nozzle animations
         const nozzle = this.processor.getNozzle()
         if (nozzle) {
            nozzle.update()
         }
         
         this.scene?.render()
         this.viewBox?.render()
         this.lastFrameUpdate = Date.now()
      })

      this.scene.onPointerObservable.add((pointerInfo) => {
         if (pointerInfo.type == PointerEventTypes.POINTERTAP) {
            const direction = this.viewBox?.pick(this.scene.pointerX, this.scene.pointerY)
            if (direction) {
               this.setCameraDirection(direction)
               return
            }
            const id = this.processor.focusedColorId
            if (id >= 0 && id < this.processor.gCodeLines.length) {
               const pos = this.processor.gCodeLines[id].filePosition
               this.processor.updateFilePosition(pos)
               this.worker.postMessage({ type: 'positionupdate', position: pos })
            }
         }
      })

      //this.loadInstrumentation()
   }

   // Snap the orbit camera so it views the bed from the given direction (viewbox face/edge/corner metadata)
   setCameraDirection(direction: ViewBoxDirection) {
      if (!this.orbitCamera || !this.bed) {
         return
      }
      const look = new Vector3(direction.x, direction.y, direction.z)
      if (look.lengthSquared() === 0) {
         return
      }
      look.normalize()
      const bedCenter = this.bed.getCenter()
      const bedSize = this.bed.getSize()
      // Straight-on views need more distance than corner views to keep the bed fully in frame
      const zeroAxes = (direction.x === 0 ? 1 : 0) + (direction.y === 0 ? 1 : 0) + (direction.z === 0 ? 1 : 0)
      const distance = Math.max(bedSize.x, bedSize.y, bedSize.z) * (zeroAxes === 2 ? 1.75 : 1.35)
      const target = new Vector3(bedCenter.x, bedCenter.z, bedCenter.y)
      this.orbitCamera.setTarget(target)
      this.orbitCamera.setPosition(target.subtract(look.scale(distance)))
      if (direction.x === 0 && direction.z === 0) {
         this.orbitCamera.alpha = (3 * Math.PI) / 2
      }
      this.scene?.render(true)
   }

   resetCamera() {
      if (!this.orbitCamera || !this.bed) {
         return
      }
      const bedCenter = this.bed.getCenter()
      const bedSize = this.bed.getSize()
      this.orbitCamera.setTarget(new Vector3(bedCenter.x, -2, bedCenter.y))
      if (this.bed.isDelta) {
         this.orbitCamera.radius = bedCenter.x
         this.orbitCamera.setPosition(new Vector3(-bedSize.x, bedSize.z, -bedSize.x))
      } else {
         this.orbitCamera.radius = bedCenter.x * 3
         this.orbitCamera.setPosition(new Vector3(-bedSize.x / 2, bedSize.z, -bedSize.y / 2))
      }
      this.scene?.render(true)
   }

   // Excluded meshes (bed, axes, object boundaries) temporarily lift the clip planes while they render
   registerClipIgnore(mesh) {
      if (!mesh) {
         return
      }
      mesh.onBeforeRenderObservable.add(() => {
         this.scene.clipPlane = null
         this.scene.clipPlane2 = null
      })
      mesh.onAfterRenderObservable.add(() => {
         if (this.zTopClipValue !== null && this.zBottomClipValue !== null) {
            this.scene.clipPlane = new Plane(0, 1, 0, this.zTopClipValue)
            this.scene.clipPlane2 = new Plane(0, -1, 0, this.zBottomClipValue)
         }
      })
   }

   showViewBox(visible: boolean) {
      this.viewBox?.show(visible)
   }

   // Toggling this off simply stops the picker's render target from rendering/reading back -
   // the GPUPicker instance itself, its shader material, and the processor's mesh pipeline are
   // never torn down, so this can be flipped on/off at any time without affecting the rest of
   // the render pipeline
   setPickingEnabled(enabled: boolean) {
      this.processor.gpuPicker.setEnabled(enabled)
   }

   setBackgroundColor(hexColor: string) {
      if (this.scene) {
         this.scene.clearColor = Color3.FromHexString(hexColor.substring(0, 7)).toColor4(1)
      }
   }

   setCameraInertia(enabled: boolean) {
      if (this.orbitCamera) {
         this.orbitCamera.inertia = enabled ? 0.9 : 0
         this.orbitCamera.panningInertia = enabled ? 0.9 : 0
      }
   }

   // Clip the model between two heights. Values are in printer Z, which maps to Babylon y
   setZClipPlane(top: number, bottom: number) {
      if (!this.scene) {
         return
      }
      if (top === null || top === undefined) {
         this.zTopClipValue = null
         this.zBottomClipValue = null
         this.scene.clipPlane = null
         this.scene.clipPlane2 = null
      } else {
         this.zTopClipValue = bottom > top ? bottom + 1 : -top
         this.zBottomClipValue = bottom
         this.scene.clipPlane = new Plane(0, 1, 0, this.zTopClipValue)
         this.scene.clipPlane2 = new Plane(0, -1, 0, this.zBottomClipValue)
      }
      this.scene.render(true)
   }

   setBuildVolume(volume: BuildVolume) {
      if (this.bed) {
         this.bed.buildVolume = volume
         this.bed.commitBedSize()
         this.axes?.render()
         this.scene?.render(true)
      }
   }

   setBedRenderMode(mode: RenderBedMode) {
      this.bed?.setRenderMode(mode)
   }

   setBedColor(color: string) {
      this.bed?.setBedColor(color)
   }

   setDeltaBed(isDelta: boolean) {
      this.bed?.setDelta(isDelta)
   }

   showBed(visible: boolean) {
      this.bed?.setVisibility(visible)
   }

   showAxes(visible: boolean) {
      this.axes?.show(visible)
   }

   loadObjectBoundaries(objects: any[]) {
      this.buildObjects?.loadObjectBoundaries(objects)
   }

   showObjectSelection(visible: boolean) {
      this.buildObjects?.showObjectSelection(visible)
   }

   showObjectLabels(visible: boolean) {
      this.buildObjects?.showLabels(visible)
   }

   isArcRotateCameraStopped(camera) {
      return (
         camera.inertialAlphaOffset === 0 &&
         camera.inertialBetaOffset === 0 &&
         camera.inertialRadiusOffset === 0 &&
         camera.inertialPanningX === 0 &&
         camera.inertialPanningY === 0
      )
   }

   loadInstrumentation() {
      const inst = new EngineInstrumentation(this.engine)
      inst.captureGPUFrameTime = true
      inst.captureShaderCompilationTime = true

      const sceneInst = new SceneInstrumentation(this.scene)

      let timer = Date.now()
      this.scene.registerAfterRender(() => {
         if (Date.now() - timer > 1000) {
            timer = Date.now()
            console.log('current frame time (GPU): ' + (inst.gpuFrameTimeCounter.current * 0.000001).toFixed(2) + 'ms')
            console.log(this.scene.meshes.length)
            console.log(`average draw calls ${sceneInst.drawCallsCounter.current}`)
         }
      })
   }

   async loadFile(file) {
      return await this.processor.loadFile(file)
   }

   async reload() {
      return await this.processor.reload()
   }

   clear() {
      this.processor.clear()
   }

   setMaxFPS(fps) {
      if (fps <= 0) fps = 1
      this.maxFrameRate = 1000 / fps
   }

   //Send message to the main thread for events we want to bind to.
   bindHandler(targetName, eventName, fn, opt) {
      const id = `${targetName}${eventName}`
      this.registeredEventHandlers.set(id, fn)

      this.worker.postMessage({
         type: 'event',
         targetName: targetName,
         eventName: eventName,
         opt: opt,
      })
   }

   //We get back events from the main thread and need to handle them here to trigger babylonjs events.
   handleEvent(eventType, event) {
      const handlerId = `${event.targetName}${event.eventName}`
      event.eventClone.preventDefault = this.noop
      event.eventClone.target = this.offscreenCanvas
      this.registeredEventHandlers.get(handlerId)(event.eventClone)
   }

   noop() {}

   unload() {
      // Otherwise the pending nozzle-animation setTimeout fires after teardown, touching a
      // disposed scene/meshes and keeping this Viewer/Processor alive in memory via its closure
      this.processor.stopNozzleAnimation()
      this.engine.dispose()
      this.scene = null
      this.engine = null
      this.worker.postMessage({ type: 'unloadComplete', params: [] })
   }
}
