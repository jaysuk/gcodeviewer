import { Scene } from '@babylonjs/core/scene'
import { Engine } from '@babylonjs/core/Engines/engine'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Viewport } from '@babylonjs/core/Maths/math.viewport'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Axis, Space } from '@babylonjs/core/Maths/math.axis'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer'
// Scene.pick is a no-op stub unless the ray module is pulled in
import '@babylonjs/core/Culling/ray'
import { makeTextPlane } from './textplane'

export interface ViewBoxDirection {
   x: number
   y: number
   z: number
}

// Orientation cube overlay in the top-right corner. Lives in its own scene rendered on top of the main scene,
// follows the orbit camera's rotation, and snaps the main camera when a face/edge/corner is clicked
export default class ViewBox {
   private scene: Scene
   private camera: ArcRotateCamera
   private mainCamera: ArcRotateCamera
   private edgeMaterial: StandardMaterial
   private highlightLayer: HighlightLayer
   private hoveredMesh: Mesh | null = null
   visible = true
   onDirectionSelected: ((direction: ViewBoxDirection) => void) | null = null

   constructor(engine: Engine, mainCamera: ArcRotateCamera) {
      this.mainCamera = mainCamera
      this.scene = new Scene(engine)
      this.scene.autoClear = false
      // Cursor changes are impossible on the faked worker-side canvas
      this.scene.doNotHandleCursors = true

      this.camera = new ArcRotateCamera('viewboxCamera', (5 * Math.PI) / 8, (5 * Math.PI) / 8, 15, Vector3.Zero(), this.scene)
      this.camera.viewport = new Viewport(0.85, 0.85, 0.15, 0.15)

      const light = new HemisphericLight('viewboxLight1', new Vector3(0, 1, 0), this.scene)
      light.intensity = 0.8
      const light2 = new HemisphericLight('viewboxLight2', new Vector3(-1, -0.5, 0), this.scene)
      light2.intensity = 0.8

      this.edgeMaterial = new StandardMaterial('viewboxEdgeMaterial', this.scene)
      this.edgeMaterial.diffuseColor = new Color3(0.5, 0.5, 0.5)

      // Highlights whichever face/edge/corner is currently under the pointer, so it's clear what
      // clicking right now would snap to - a HighlightLayer works uniformly across all three mesh
      // shapes without needing every one of them to own a unique material (edges share one, and
      // faces/corners aren't guaranteed to either)
      this.highlightLayer = new HighlightLayer('viewboxHighlight', this.scene, {
         // The gizmo's individual meshes (edges, corner spheres) are small on screen - the
         // default blur size produced a glow too thin to clearly read as "this is what you're
         // about to click"
         blurHorizontalSize: 3,
         blurVerticalSize: 3,
      })
      this.highlightLayer.outerGlow = true
      this.highlightLayer.innerGlow = true

      const x = 3.9
      this.buildEdge('FrontLeft', new Vector3(-x, 0, -x))
      this.buildEdge('BackLeft', new Vector3(-x, 0, x))
      this.buildEdge('BackRight', new Vector3(x, 0, x))
      this.buildEdge('FrontRight', new Vector3(x, 0, -x))

      this.buildEdge('TopFront', new Vector3(0, x, -x))
      this.buildEdge('TopBack', new Vector3(0, x, x))
      this.buildEdge('TopLeft', new Vector3(-x, x, 0))
      this.buildEdge('TopRight', new Vector3(x, x, 0))

      this.buildEdge('BottomFront', new Vector3(0, -x, -x))
      this.buildEdge('BottomBack', new Vector3(0, -x, x))
      this.buildEdge('BottomLeft', new Vector3(-x, -x, 0))
      this.buildEdge('BottomRight', new Vector3(x, -x, 0))

      this.buildCorner('FrontTopLeft', new Vector3(-3, 3, -3))
      this.buildCorner('FrontTopRight', new Vector3(3, 3, -3))
      this.buildCorner('BackTopLeft', new Vector3(-3, 3, 3))
      this.buildCorner('BackTopRight', new Vector3(3, 3, 3))

      this.buildCorner('FrontBottomLeft', new Vector3(-3, -3, -3))
      this.buildCorner('FrontBottomRight', new Vector3(3, -3, -3))
      this.buildCorner('BackBottomLeft', new Vector3(-3, -3, 3))
      this.buildCorner('BackBottomRight', new Vector3(3, -3, 3))

      this.buildPlane('Front', new Vector3(0, 0, 1))
      this.buildPlane('Right', new Vector3(-1, 0, 0))
      this.buildPlane('Back', new Vector3(0, 0, -1))
      this.buildPlane('Left', new Vector3(1, 0, 0))
      this.buildPlane('Top', new Vector3(0, -1, 0))
      this.buildPlane('Bottom', new Vector3(0, 1, 0))

   }

   // Pointer events only reach the main scene in the worker, so the caller forwards moves here too
   // (this scene has only ~26 simple meshes regardless of model size, so picking on every move is
   // cheap - unlike the main scene, which turns this off deliberately)
   updateHover(x: number, y: number): void {
      if (!this.visible) {
         this.clearHover()
         return
      }
      const pickResult = this.scene.pick(x, y, undefined, false, this.camera)
      const mesh = pickResult.hit ? (pickResult.pickedMesh as Mesh) : null
      if (mesh === this.hoveredMesh) {
         return
      }
      if (this.hoveredMesh) {
         this.highlightLayer.removeMesh(this.hoveredMesh)
      }
      this.hoveredMesh = mesh
      if (mesh) {
         this.highlightLayer.addMesh(mesh, new Color3(1, 1, 0))
      }
   }

   clearHover(): void {
      if (this.hoveredMesh) {
         this.highlightLayer.removeMesh(this.hoveredMesh)
         this.hoveredMesh = null
      }
   }

   // Pointer events only reach the main scene in the worker, so the caller forwards taps here for manual picking
   pick(x: number, y: number): ViewBoxDirection | null {
      if (!this.visible) {
         return null
      }
      const pickResult = this.scene.pick(x, y, undefined, false, this.camera)
      if (pickResult.hit && pickResult.pickedMesh?.metadata) {
         return pickResult.pickedMesh.metadata as ViewBoxDirection
      }
      return null
   }

   private buildPlane(name: string, rotationVector: Vector3) {
      const plane = makeTextPlane(this.scene, name, 'white', '#333333', 6, 6, 90)
      plane.name = name
      plane.lookAt(rotationVector)
      plane.position = rotationVector.scale(-3)
      if (name === 'Top') {
         plane.rotate(Axis.Z, Math.PI / 2, Space.LOCAL)
      }
      if (name === 'Bottom') {
         plane.rotate(Axis.Z, -Math.PI / 2, Space.LOCAL)
      }
      plane.metadata = {
         x: Math.sign(rotationVector.x),
         y: Math.sign(rotationVector.y),
         z: Math.sign(rotationVector.z),
      }
      plane.isPickable = true
   }

   private buildCorner(name: string, cornerVector: Vector3) {
      const sphere = MeshBuilder.CreateSphere(name, { diameter: 1.1 }, this.scene)
      sphere.position = new Vector3(
         cornerVector.x - Math.sign(cornerVector.x) * 0.25,
         cornerVector.y - Math.sign(cornerVector.y) * 0.1,
         cornerVector.z - Math.sign(cornerVector.z) * 0.25,
      )
      sphere.metadata = {
         x: Math.sign(cornerVector.x) * -1,
         y: Math.sign(cornerVector.y) * -1,
         z: Math.sign(cornerVector.z) * -1,
      }
      sphere.isPickable = true
   }

   private buildEdge(name: string, edgeVector: Vector3) {
      const box = MeshBuilder.CreateBox(name, { width: 0.35, height: 5.8, depth: 0.35 }, this.scene)
      if (edgeVector.y !== 0) {
         box.rotate(Axis.Z, Math.PI / 2, Space.WORLD)
         if (edgeVector.x !== 0) box.rotate(Axis.Y, Math.PI / 2, Space.WORLD)
         box.bakeCurrentTransformIntoVertices()
      }
      box.position = new Vector3(
         edgeVector.x - Math.sign(edgeVector.x),
         edgeVector.y - Math.sign(edgeVector.y),
         edgeVector.z - Math.sign(edgeVector.z),
      )
      box.metadata = {
         x: Math.sign(edgeVector.x) * -1,
         y: Math.sign(edgeVector.y) * -1,
         z: Math.sign(edgeVector.z) * -1,
      }
      box.material = this.edgeMaterial
      box.isPickable = true
   }

   // Call once per frame after the main scene has rendered
   render() {
      if (!this.visible) {
         return
      }
      this.camera.alpha = this.mainCamera.alpha
      this.camera.beta = this.mainCamera.beta
      this.camera.radius = 15
      this.scene.render()
   }

   show(visible: boolean) {
      this.visible = visible
   }

   dispose() {
      this.scene.dispose()
   }
}
