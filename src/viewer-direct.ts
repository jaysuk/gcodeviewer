import Viewer from './viewer'
import ViewerApi from './viewer-api'

export default class ViewerDirect implements ViewerApi {
   viewer: Viewer
   mainCanvas: HTMLCanvasElement | null = null
   passThru: any = null

   private onWindowResize = () => {
      this.resize()
   }

   // See ViewerProxy.resize() - covers layout changes that don't fire a window resize event
   resize(): void {
      this.viewer.setSizes(this.mainCanvas?.clientWidth, this.mainCanvas?.clientHeight)
   }

   constructor(canvas: HTMLCanvasElement) {
      this.mainCanvas = canvas
      this.viewer = new Viewer()
      this.viewer.init_direct(canvas, this)
      this.viewer.initEngine()

      // addEventListener (not window.onresize=) so this doesn't clobber the host page's own
      // resize handler or a second viewer instance's handler
      window.addEventListener('resize', this.onWindowResize)
   }

   init(): void {}

   postMessage(message: any) {
      if (this.passThru) {
         this.passThru(message)
      }
   }

   loadFile(file): Promise<{ start: number; end: number; failed: boolean }> {
      return this.viewer.loadFile(file)
   }

   reload(): Promise<{ start: number; end: number; failed: boolean }> {
      return this.viewer.reload()
   }

   clear(): Promise<void> {
      this.viewer.clear()
      return Promise.resolve()
   }

   unload(): void {
      window.removeEventListener('resize', this.onWindowResize)
      this.viewer.unload()
   }

   updateFilePosition(filePosition: number, animate: boolean = false): void {
      this.viewer.processor.updateFilePosition(filePosition, animate)
   }

   getGCodes(position: number, count: number): void {
      this.viewer.processor.getGCodeInRange(position, count)
   }

   goToLineNumber(lineNumber: number): void {
      this.viewer.processor.updateByLineNumber(lineNumber)
   }

   setAlphaMode(mode: boolean): void {
      this.viewer.processor.modelMaterial.forEach((m) => m.setAlphaMode(mode))
   }

   setProgressMode(mode: boolean): void {
      this.viewer.processor.modelMaterial.forEach((m) => m.setProgressMode(mode))
   }

   setRenderMode(mode: number): void {
      this.viewer.processor.modelMaterial.forEach((m) => m.updateRenderMode(mode))
   }

   setMaxFPS(fps: number): void {
      this.viewer.setMaxFPS(fps)
   }

   setMeshMode(mode: number): void {
      this.viewer.processor.setMeshMode(mode)
   }

   setPerimeterOnly(perimeterOnly: boolean): void {
      this.viewer.processor.setPerimeterOnly(perimeterOnly)
   }

   setPickingEnabled(enabled: boolean): void {
      this.viewer.setPickingEnabled(enabled)
   }

   showViewBox(visible: boolean): void {
      this.viewer.showViewBox(visible)
   }

   setCameraDirection(direction: { x: number; y: number; z: number }): void {
      this.viewer.setCameraDirection(direction)
   }

   resetCamera(): void {
      this.viewer.resetCamera()
   }

   setBackgroundColor(color: string): void {
      this.viewer.setBackgroundColor(color)
   }

   setProgressColor(color: string): void {
      this.viewer.setProgressColor(color)
   }

   setZBelt(enabled: boolean, angle: number): void {
      this.viewer.setZBelt(enabled, angle)
   }

   setCameraInertia(enabled: boolean): void {
      this.viewer.setCameraInertia(enabled)
   }

   setZClipPlane(top: number, bottom: number): void {
      this.viewer.setZClipPlane(top, bottom)
   }

   setTools(tools: { color: string; diameter?: number }[]): void {
      this.viewer.processor.setTools(tools)
   }

   setBuildVolume(volume: { x: { min: number; max: number }; y: { min: number; max: number }; z: { min: number; max: number } }): void {
      this.viewer.setBuildVolume(volume)
   }

   setBedRenderMode(mode: number): void {
      this.viewer.setBedRenderMode(mode)
   }

   setBedColor(color: string): void {
      this.viewer.setBedColor(color)
   }

   setDeltaBed(isDelta: boolean): void {
      this.viewer.setDeltaBed(isDelta)
   }

   showBed(visible: boolean): void {
      this.viewer.showBed(visible)
   }

   showAxes(visible: boolean): void {
      this.viewer.showAxes(visible)
   }

   loadObjectBoundaries(objects: any[]): void {
      this.viewer.loadObjectBoundaries(objects)
   }

   showObjectSelection(visible: boolean): void {
      this.viewer.showObjectSelection(visible)
   }

   showObjectLabels(visible: boolean): void {
      this.viewer.showObjectLabels(visible)
   }

   toggleNozzle(visible: boolean): void {
      const nozzle = this.viewer.processor.getNozzle()
      if (nozzle) {
         if (visible) {
            nozzle.show()
         } else {
            nozzle.hide()
         }
      }
   }

   startNozzleAnimation(): void {
      this.viewer.processor.startNozzleAnimation()
   }

   pauseNozzleAnimation(): void {
      this.viewer.processor.pauseNozzleAnimation()
   }

   resumeNozzleAnimation(): void {
      this.viewer.processor.resumeNozzleAnimation()
   }

   stopNozzleAnimation(): void {
      this.viewer.processor.stopNozzleAnimation()
   }

   enableWasmProcessing(): Promise<void> {
      return this.viewer.processor.enableWasmProcessing()
   }

   getProcessingStats(): Promise<any> {
      return Promise.resolve(this.viewer.processor.getProcessingStats())
   }
}
