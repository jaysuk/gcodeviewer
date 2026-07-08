import { Scene } from '@babylonjs/core/scene'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { PointerEventTypes, PointerInfo } from '@babylonjs/core/Events/pointerEvents'
import { PickingInfo } from '@babylonjs/core/Collisions/pickingInfo'
import { Observer } from '@babylonjs/core/Misc/observable'
import { makeTextPlane } from './textplane'


export default class BuildObjects {
   scene: Scene
   buildObjectMeshes: Mesh[] = []
   labels: Mesh[] = []
   baseMaterial: StandardMaterial = null
   highlightMaterial: StandardMaterial = null
   cancelledMaterial: StandardMaterial = null
   cancelledHighlightMaterial: StandardMaterial = null
   private xmarkTexture: DynamicTexture = null
   showCancelObjects = false
   showLabel = true
   alphaLevel = 0.5

   objectCallback: (metadata: any) => void = null
   renderFailedCallback: () => void = null
   labelCallback: (name: string) => void = null
   registerClipIgnore: (mesh: Mesh) => void = null
   getMaxHeight: () => number = null

   private observableControls: Observer<PointerInfo> = null

   constructor(scene: Scene) {
      this.scene = scene
      this.rebuildMaterials()
   }

   setBuildMaterial(name: string, color: Color3, alpha?: number): StandardMaterial {
      if (!alpha) {
         alpha = this.alphaLevel
      }

      const material = new StandardMaterial(name, this.scene)
      material.diffuseColor = color
      material.specularColor = new Color3(0, 0, 0)
      material.alpha = alpha
      material.needAlphaTesting = () => true
      material.separateCullingPass = true
      material.backFaceCulling = true
      return material
   }

   rebuildMaterials() {
      // Called on every loadObjectBoundaries() (once per job/print update) - dispose the
      // previous set first, or each call leaks 4 materials + a texture
      this.baseMaterial?.dispose()
      this.highlightMaterial?.dispose()
      this.cancelledMaterial?.dispose()
      this.cancelledHighlightMaterial?.dispose()
      this.xmarkTexture?.dispose()

      this.baseMaterial = this.setBuildMaterial('BuildObjectBaseMaterial', new Color3(0.1, 0.5, 0.1), 0.25)
      this.highlightMaterial = this.setBuildMaterial('BuildObjectHighlightMaterial', new Color3(0.8, 0.8, 0.8))
      this.cancelledMaterial = this.setBuildMaterial('BuildObjectCancelledMaterial', new Color3(1, 0, 0), 0.4)
      this.cancelledHighlightMaterial = this.setBuildMaterial('BuildObjectCancelledHighlightMaterial', new Color3(1, 1, 0), 0.6)
      this.xmarkTexture = this.buildXMarkTexture()
      this.cancelledMaterial.diffuseTexture = this.xmarkTexture
      this.cancelledHighlightMaterial.diffuseTexture = this.xmarkTexture
   }

   // Image decoding is unavailable in the render worker, so the cancelled-object X mark is drawn onto a DynamicTexture
   private buildXMarkTexture(): DynamicTexture {
      const size = 128
      const texture = new DynamicTexture('xmark', { width: size, height: size }, this.scene, true)
      const ctx = texture.getContext()
      ctx.fillStyle = '#990000'
      ctx.fillRect(0, 0, size, size)
      ctx.strokeStyle = '#ffeeee'
      ctx.lineWidth = 14
      const inset = size * 0.22
      ctx.beginPath()
      ctx.moveTo(inset, inset)
      ctx.lineTo(size - inset, size - inset)
      ctx.moveTo(size - inset, inset)
      ctx.lineTo(inset, size - inset)
      ctx.stroke()
      texture.update()
      return texture
   }

   loadObjectBoundaries(boundaryObjects: any[]) {
      this.rebuildMaterials()
      if (this.buildObjectMeshes.length > 0) {
         // Labels are parented to the object meshes, so disposing the meshes disposes the labels too
         for (const mesh of this.buildObjectMeshes) {
            mesh.dispose()
         }
         this.buildObjectMeshes = []
         this.labels = []
      }

      if (!boundaryObjects) {
         return
      }

      for (let cancelObjectIdx = 0; cancelObjectIdx < boundaryObjects.length; cancelObjectIdx++) {
         const cancelObject = boundaryObjects[cancelObjectIdx]

         const buildObject = MeshBuilder.CreateTiledBox(
            'OBJECTMESH:' + cancelObject.name,
            {
               pattern: Mesh.CAP_ALL,
               alignVertical: Mesh.TOP,
               alignHorizontal: Mesh.LEFT,
               tileHeight: 4,
               tileWidth: 4,
               width: Math.abs(cancelObject.x[1] - cancelObject.x[0]),
               height: this.getMaxHeight() + 10,
               depth: Math.abs(cancelObject.y[1] - cancelObject.y[0]),
               sideOrientation: Mesh.FRONTSIDE
            },
            this.scene
         )

         // G-code X/Y map to Babylon X/Z, the box height spans the Babylon Y (up) axis
         buildObject.position.x = (cancelObject.x[1] + cancelObject.x[0]) / 2
         buildObject.position.y = this.getMaxHeight() / 2 - 4
         buildObject.position.z = (cancelObject.y[1] + cancelObject.y[0]) / 2
         buildObject.alphaIndex = 5000000
         cancelObject.index = cancelObjectIdx
         buildObject.metadata = cancelObject
         buildObject.enablePointerMoveEvents = true
         buildObject.renderingGroupId = 3
         this.setObjectTexture(buildObject)
         buildObject.setEnabled(this.showCancelObjects)
         this.registerClipIgnore(buildObject)
         this.buildObjectMeshes.push(buildObject)

         const textPlane = makeTextPlane(this.scene, cancelObject.name, cancelObject.cancelled ? 'yellow' : 'white', 'transparent', 20, 8)
         const textPlaneMaterial = textPlane.material as StandardMaterial
         textPlaneMaterial.backFaceCulling = false
         if (textPlaneMaterial.diffuseTexture) {
            textPlaneMaterial.diffuseTexture.hasAlpha = true
         }
         textPlane.billboardMode = Mesh.BILLBOARDMODE_ALL
         textPlane.position = new Vector3(0, this.getMaxHeight() / 2 + 10, 0)
         textPlane.isPickable = false
         textPlane.metadata = cancelObject
         textPlane.parent = buildObject
         textPlane.setEnabled(this.showLabel)
         this.registerClipIgnore(textPlane)
         this.labels.push(textPlane)
      }
   }

   buildObservables() {
      if (this.observableControls) {
         return
      }

      let hitTestTimer = 0
      let mouseDown = false
      let cancelHitTimer = 0

      this.observableControls = this.scene.onPointerObservable.add((pointerInfo) => {
         const pickInfo = pointerInfo.pickInfo
         switch (pointerInfo.type) {
            case PointerEventTypes.POINTERDOWN:
               mouseDown = true
               cancelHitTimer = Date.now()
               break
            case PointerEventTypes.POINTERUP:
               mouseDown = false
               // Treat only short presses as clicks so camera drags do not cancel objects
               if (Date.now() - cancelHitTimer > 200) {
                  return
               }
               this.handleClick(pickInfo)
               break
            case PointerEventTypes.POINTERMOVE:
               if (mouseDown || Date.now() - hitTestTimer < 100) {
                  return
               }
               hitTestTimer = Date.now()
               this.handlePointerMove(pickInfo)
               break
         }
      })
   }

   clearObservables() {
      if (this.observableControls) {
         this.scene.onPointerObservable.remove(this.observableControls)
         this.observableControls = null
      }
   }

   showObjectSelection(visible: boolean) {
      this.showCancelObjects = visible
      this.buildObjectMeshes.forEach((mesh) => mesh.setEnabled(visible))

      if (visible) {
         this.buildObservables()
      } else {
         this.clearObservables()
      }
   }

   setObjectTexture(mesh: Mesh) {
      if (mesh.metadata.cancelled) {
         mesh.material = this.cancelledMaterial
         mesh.enableEdgesRendering()
         mesh.edgesWidth = 15.0
         mesh.edgesColor = new Color4(1, 0, 0, 1)
      } else {
         mesh.material = this.baseMaterial
         mesh.enableEdgesRendering()
         mesh.edgesWidth = 15.0
         mesh.edgesColor = new Color4(0, 1, 0, 1)
      }
   }

   handleClick(pickInfo: PickingInfo) {
      if (!this.showCancelObjects) {
         return
      }
      if (pickInfo.hit && pickInfo.pickedMesh && pickInfo.pickedMesh.name.includes('OBJECTMESH') && this.objectCallback) {
         this.objectCallback(pickInfo.pickedMesh.metadata)
      }
   }

   handlePointerMove(pickInfo: PickingInfo) {
      if (!this.showCancelObjects) {
         return
      }
      this.buildObjectMeshes.forEach((mesh) => this.setObjectTexture(mesh))
      if (pickInfo.hit && pickInfo.pickedMesh && pickInfo.pickedMesh.name.includes('OBJECTMESH')) {
         pickInfo.pickedMesh.material = pickInfo.pickedMesh.metadata.cancelled ? this.cancelledHighlightMaterial : this.highlightMaterial
         if (this.labelCallback) {
            this.labelCallback(pickInfo.pickedMesh.metadata.name)
         }
      } else {
         if (this.labelCallback) {
            this.labelCallback('')
         }
      }
   }

   showLabels(visible: boolean) {
      this.showLabel = visible
      this.labels.forEach((label) => label.setEnabled(visible))
   }
}
