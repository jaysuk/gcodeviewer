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
   // Small axis-cross marking the active workplace's (G54-G59.3) origin - reuses the Axes
   // renderable at a smaller size rather than a bespoke mesh, since "an axis cross at a position"
   // is exactly what a workplace-offset gizmo needs
   workplaceGizmo: Axes | null = null
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

      this.workplaceGizmo = new Axes(this.scene)
      this.workplaceGizmo.size = 15
      this.workplaceGizmo.registerClipIgnore = (mesh) => {
         this.registerClipIgnore(mesh)
      }
      this.workplaceGizmo.render()
      this.workplaceGizmo.show(false) // Hidden until showWorkplace(true) is called
      this.updateWorkplaceGizmoPosition()

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

   // Frames the camera on the loaded print's bounding box (when embedded, e.g. the Job Status
   // tab) or the bed footprint otherwise. Call after a file load and whenever the view should
   // reset to "show me everything". Ported from the consumer side (DWC) rather than developed
   // fresh here, since the math is coordinate-system-agnostic and needs the real camera/engine,
   // which only exist in this worker - a consumer can no longer reach `scene.activeCamera` itself.
   frameToContent(isEmbedded: boolean) {
      if (!this.orbitCamera || !this.bed) {
         return
      }
      const bounds = isEmbedded ? this.processor.getPrintBounds() : null
      if (bounds) {
         const target = new Vector3(
            (bounds.min.x + bounds.max.x) / 2,
            (bounds.min.y + bounds.max.y) / 2,
            (bounds.min.z + bounds.max.z) / 2,
         )
         this.orbitCamera.setTarget(target)
      } else {
         const center = this.bed.getCenter()
         this.orbitCamera.setTarget(new Vector3(center.x, -2, center.y))
      }
      this.orbitCamera.alpha = -Math.PI / 2
      this.orbitCamera.beta = Math.PI / 4
      this.frameToViewport(this.framingCorners(bounds))
      this.scene?.render(true)
   }

   // Corners fed to the framing fit: the eight corners of the print bounding box, or - with
   // nothing loaded - the four bed-footprint corners on the bed plane. All in Babylon space (y is
   // height)
   private framingCorners(
      bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null,
   ): Array<[number, number, number]> {
      if (bounds) {
         const lo = bounds.min
         const hi = bounds.max
         return [
            [lo.x, lo.y, lo.z], [hi.x, lo.y, lo.z], [lo.x, lo.y, hi.z], [hi.x, lo.y, hi.z],
            [lo.x, hi.y, lo.z], [hi.x, hi.y, lo.z], [lo.x, hi.y, hi.z], [hi.x, hi.y, hi.z],
         ]
      }
      const center = this.bed.getCenter()
      const size = this.bed.getSize()
      const hx = size.x / 2
      const hy = size.y / 2
      return [
         [center.x - hx, -2, center.y - hy], [center.x + hx, -2, center.y - hy],
         [center.x - hx, -2, center.y + hy], [center.x + hx, -2, center.y + hy],
      ]
   }

   // Pull the orbit camera back until the supplied bounding-box corners fill the viewport. Each
   // corner is projected with the live view + projection matrices and the radius is rescaled from
   // how much of the clip volume they span, so the fit adapts to the box size, the camera tilt
   // and the viewport aspect ratio. A strip is reserved at the bottom so a host's playback
   // controls overlay stays clear. Perspective makes a single pass approximate, hence the short
   // converging loops.
   private frameToViewport(corners: Array<[number, number, number]>) {
      const camera = this.orbitCamera
      if (!camera || corners.length === 0 || !this.engine) {
         return
      }

      let spanMinX = Infinity, spanMaxX = -Infinity
      let spanMinY = Infinity, spanMaxY = -Infinity
      let spanMinZ = Infinity, spanMaxZ = -Infinity
      for (const [x, y, z] of corners) {
         spanMinX = Math.min(spanMinX, x); spanMaxX = Math.max(spanMaxX, x)
         spanMinY = Math.min(spanMinY, y); spanMaxY = Math.max(spanMaxY, y)
         spanMinZ = Math.min(spanMinZ, z); spanMaxZ = Math.max(spanMaxZ, z)
      }
      const maxSpan = Math.max(spanMaxX - spanMinX, spanMaxY - spanMinY, spanMaxZ - spanMinZ, 1)

      // Before the canvas has a real size the projection matrix is degenerate; fall back to a
      // rough radius and let the next call (after layout / a file load) frame it properly
      if (this.engine.getRenderWidth() < 1 || this.engine.getRenderHeight() < 1) {
         camera.radius = 2 * maxSpan
         return
      }

      // Start far enough back that every corner is in front of the camera on the first pass
      camera.radius = 2 * maxSpan

      // Zoom so the box fills 95% of the viewport width or 74% of its height, whichever binds
      // first - the rest stays as breathing room
      const targetX = 0.95
      const targetY = 0.74
      for (let pass = 0; pass < 8; pass++) {
         const view = camera.getViewMatrix(true).m
         const proj = camera.getProjectionMatrix(true).m
         let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, behind = false
         for (const [x, y, z] of corners) {
            // World -> view space (the view matrix is affine, so w stays 1)
            const vx = view[0] * x + view[4] * y + view[8] * z + view[12]
            const vy = view[1] * x + view[5] * y + view[9] * z + view[13]
            const vz = view[2] * x + view[6] * y + view[10] * z + view[14]
            // View -> clip space
            const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15]
            if (cw <= 0) {
               behind = true
               break
            }
            const ndcX = (proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12]) / cw
            const ndcY = (proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13]) / cw
            minX = Math.min(minX, ndcX); maxX = Math.max(maxX, ndcX)
            minY = Math.min(minY, ndcY); maxY = Math.max(maxY, ndcY)
         }
         if (behind || !Number.isFinite(minX)) {
            camera.radius *= 2
            continue
         }
         // The visible clip range is [-1, 1] on each axis. Rescale by whichever axis overshoots
         // its target fill fraction the most
         const xFill = (maxX - minX) / 2
         const yFill = (maxY - minY) / 2
         if (xFill <= 0 && yFill <= 0) {
            break
         }
         const nextRadius = camera.radius * Math.max(xFill / targetX, yFill / targetY)
         const converged = Math.abs(nextRadius - camera.radius) < camera.radius * 0.01
         camera.radius = nextRadius
         if (converged) {
            break
         }
      }

      // Centre the box vertically between the top of a host playback-controls overlay and the
      // top of the viewport - clip-space y +0.1 is the midpoint of that band. Perspective skews
      // the projected box, so the look-at point is nudged until the box centre lands; damped
      // empirical steps converge without depending on the exact FOV
      const desiredCenter = 0.1
      for (let pass = 0; pass < 6; pass++) {
         const view = camera.getViewMatrix(true).m
         const proj = camera.getProjectionMatrix(true).m
         let minY = Infinity, maxY = -Infinity
         for (const [x, y, z] of corners) {
            const vx = view[0] * x + view[4] * y + view[8] * z + view[12]
            const vy = view[1] * x + view[5] * y + view[9] * z + view[13]
            const vz = view[2] * x + view[6] * y + view[10] * z + view[14]
            const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15]
            if (cw <= 0) {
               continue
            }
            const ndcY = (proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13]) / cw
            minY = Math.min(minY, ndcY)
            maxY = Math.max(maxY, ndcY)
         }
         if (!Number.isFinite(minY)) {
            break
         }
         const deltaNdc = desiredCenter - (minY + maxY) / 2
         if (Math.abs(deltaNdc) < 0.01) {
            break
         }
         // Lowering the target lifts the scene; ~0.6 radius per NDC unit lands close and the
         // loop mops up the rest
         const t = camera.target
         camera.target = new Vector3(t.x, t.y - deltaNdc * 0.6 * camera.radius, t.z)
      }
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

   setProgressColor(hexColor: string) {
      this.processor.setProgressColor(hexColor)
   }

   // Belt-printer kinematics (props.zBelt/gantryAngle) are parse-time settings - call reload()
   // afterwards to re-parse the current file under the new kinematics
   setZBelt(enabled: boolean, angle: number) {
      this.processor.setZBelt(enabled, angle)
   }

   // CNC mode (treat every G1 as an extrusion) is also a parse-time setting - call reload()
   // afterwards, same as setZBelt
   setG1AsExtrusion(enabled: boolean) {
      this.processor.setG1AsExtrusion(enabled)
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

   showWorkplace(visible: boolean) {
      this.workplaceGizmo?.show(visible)
   }

   // G-code (x, y, z) -> Babylon (x, z, y), matching Axes/Bed's own coordinate convention
   private updateWorkplaceGizmoPosition() {
      const offset = this.processor.getCurrentWorkplaceOffset()
      if (!this.workplaceGizmo || !offset) {
         return
      }
      this.workplaceGizmo.render(new Vector3(offset.x, offset.z, offset.y))
      this.scene?.render(true)
   }

   setWorkplaceOffsets(offsets: { x: number; y: number; z: number }[]) {
      this.processor.setWorkplaceOffsets(offsets)
      this.updateWorkplaceGizmoPosition()
   }

   setCurrentWorkplaceIndex(index: number) {
      this.processor.setCurrentWorkplaceIndex(index)
      this.updateWorkplaceGizmoPosition()
   }

   setNozzlePosition(position: { x: number; y: number; z: number }) {
      this.processor.setNozzlePosition(position)
   }

   setShowTravels(visible: boolean) {
      this.processor.setShowTravels(visible)
   }

   setPersistTravels(persist: boolean) {
      this.processor.setPersistTravels(persist)
   }

   setFeedColors(minColor: string, maxColor: string) {
      this.processor.setFeedColors(minColor, maxColor)
   }

   setFeedRateRange(min: number | null, max: number | null) {
      this.processor.setFeedRateRange(min, max)
   }

   setTransparency(percent: number) {
      this.processor.setTransparency(percent)
   }

   setUseSpecular(enabled: boolean) {
      this.processor.setUseSpecular(enabled)
   }

   cancelLoad() {
      this.processor.cancelLoad()
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
      const result = await this.processor.loadFile(file)
      this.updateWorkplaceGizmoPosition()
      return result
   }

   async reload() {
      const result = await this.processor.reload()
      this.updateWorkplaceGizmoPosition()
      return result
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
