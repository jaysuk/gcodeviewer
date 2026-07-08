import { Engine } from '@babylonjs/core/Engines/engine'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Scene } from '@babylonjs/core/scene'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import '@babylonjs/core/Engines/thinEngine'

export default class GPUPicker {
   scene: Scene
   engine: Engine
   renderTarget: RenderTargetTexture
   width: number
   height: number
   colorTestCallBack: any
   currentPosition: number = 0
   renderTargetMeshs: Mesh[] = []
   enabled: boolean = true

   shaderMaterial: ShaderMaterial

   // A single reused framebuffer for the pick readback - the previous implementation created and
   // never deleted a new one every frame (an unbounded GPU object leak)
   private frameBuffer: WebGLFramebuffer | null = null
   private readonly pixelBuffer = new Uint8Array(4)

   constructor(scene: Scene, engine: Engine, width: number, height: number) {
      this.scene = scene
      this.engine = engine
      this.width = width
      this.height = height
      // generateMipMaps=false: this texture is only ever point-sampled for picking, never minified
      this.renderTarget = new RenderTargetTexture('rt', { width, height }, this.scene, false)
      this.renderTarget.clearColor = new Color4(0, 0, 0, 0)
      this.renderTarget.refreshRate = 1
      this.scene.customRenderTargets.push(this.renderTarget)
      this.shaderMaterial = new ShaderMaterial(
         'pick_mat',
         this.scene,
         {
            vertexSource: vertexShader,
            fragmentSource: fragmentShader,
         },
         {
            attributes: ['position', 'pickColor', 'filePosition', 'tool'],
            uniforms: [
               'world',
               'worldView',
               'worldViewProjection',
               'view',
               'projection',
               'viewProjection',
               'currentPosition',
            ],
         },
      )

      this.renderTarget.onAfterRenderObservable.add(() => {
         if (!this.enabled) {
            return
         }
         try {
            const x = Math.round(this.scene.pointerX)
            const y = this.height - Math.round(this.scene.pointerY)

            const pixels = this.readTexturePixels(x, y, 1, 1)
            if (pixels && this.colorTestCallBack) {
               this.colorTestCallBack(pixels)
            }
         } catch (error) {
            // A picking failure must never take down the main render loop
            console.error('GPUPicker: failed to read pick texture', error)
         }
      })
   }

   readTexturePixels(x, y, w, h): Uint8Array | null {
      // The underlying WebGL texture is transiently unavailable during resize/rebuild
      const hardwareTexture = this.renderTarget._texture?._hardwareTexture
      const underlyingResource = hardwareTexture?.underlyingResource
      if (!underlyingResource) {
         return null
      }

      const gl = this.engine._gl
      if (!this.frameBuffer) {
         this.frameBuffer = gl.createFramebuffer()
      }

      // Babylon manages its own framebuffer binding cache - save and restore it so this read
      // doesn't leave GL state that the next Babylon draw call doesn't expect
      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING)

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.frameBuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, underlyingResource, 0)
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer)
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer)

      return this.pixelBuffer
   }

   updateRenderTargetSize(width, height) {
      this.width = width
      this.height = height
      this.renderTarget.resize({ width, height })
   }

   // Enable/disable picking without tearing down the shader material, so re-enabling is cheap.
   // Disabling removes the render target from the scene's custom render targets entirely, rather
   // than leaving it (and every gpuPicker call site) to fail once some other part of the pipeline
   // assumes picking is unavailable.
   setEnabled(enabled: boolean) {
      if (this.enabled === enabled) {
         return
      }
      this.enabled = enabled
      if (enabled) {
         if (!this.scene.customRenderTargets.includes(this.renderTarget)) {
            this.scene.customRenderTargets.push(this.renderTarget)
         }
         this.renderTarget.renderList = [...this.renderTargetMeshs]
      } else {
         const idx = this.scene.customRenderTargets.indexOf(this.renderTarget)
         if (idx !== -1) {
            this.scene.customRenderTargets.splice(idx, 1)
         }
         this.renderTarget.renderList = []
      }
   }

   clearRenderList() {
      this.renderTargetMeshs = []
      this.renderTarget.renderList = []
   }

   // Registers the mesh set that should back picking right now (e.g. whichever mesh-mode variant
   // is currently visible). Replaces whatever was previously registered.
   setActiveMeshes(meshes: Mesh[]) {
      this.renderTargetMeshs = meshes
      if (meshes.length > 0) {
         this.renderTarget.setMaterialForRendering(meshes, this.shaderMaterial)
      }
      if (this.enabled) {
         this.renderTarget.renderList = [...meshes]
      }
   }

   updateCurrentPosition(currentPosition: number) {
      this.currentPosition = currentPosition
      this.shaderMaterial.setFloat('currentPosition', this.currentPosition)
   }

   dispose() {
      this.setEnabled(false)
      if (this.frameBuffer) {
         this.engine._gl.deleteFramebuffer(this.frameBuffer)
         this.frameBuffer = null
      }
      this.renderTarget.dispose()
      this.shaderMaterial.dispose()
   }
}

const vertexShader = `
// Vertex shader
#if defined(WEBGL2) || defined(WEBGPU)
precision highp sampler2DArray;
#endif
precision highp float;

        // Attributes
        attribute vec3 position;
         attribute vec3 pickColor;
         attribute float filePosition;
         attribute float tool;

        // Uniforms
        uniform mat4 viewProjection;
        uniform float currentPosition;


        //to fragment

        flat out vec4 vPickColor;
        flat out float vShow;
        flat out float fTool;

#include<instancesDeclaration>


void main(void) {
   #include<instancesVertex>
   gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
   vPickColor = vec4(pickColor, 1.0);
   vShow = currentPosition - filePosition;
   fTool = tool;
}
`

const fragmentShader = `
// Fragment shader
#if defined(PREPASS)
#extension GL_EXT_draw_buffers : require
layout(location = 0) out highp vec4 glFragData[SCENE_MRT_COUNT];
highp vec4 gl_FragColor;
#endif
#if defined(WEBGL2) || defined(WEBGPU)
precision highp sampler2DArray;
#endif
precision highp float;

uniform mat4 u_World;
uniform mat4 u_ViewProjection;
uniform vec4 u_color;


flat in vec4 vPickColor;
flat in float vShow;
flat in float fTool;

#include<helperFunctions>

void main(void) {
   if(vShow < 0.0f || fTool >= 255.0)
   {
      discard;
   }
   else
   {
      gl_FragColor = vPickColor;
      #ifdef CONVERTTOLINEAR0
      gl_FragColor = toLinearSpace(gl_FragColor);
      #endif
      #ifdef CONVERTTOGAMMA0
      gl_FragColor = toGammaSpace(gl_FragColor);
      #endif
      #if defined(PREPASS)
      gl_FragData[0] = gl_FragColor;
      #endif
   }
}
`
