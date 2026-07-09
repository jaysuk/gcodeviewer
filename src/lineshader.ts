import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { Scene } from '@babylonjs/core/scene'
import { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import { Vector4 } from '@babylonjs/core/Maths/math.vector'
import '@babylonjs/core/Materials/standardMaterial'

export default class LineShaderMaterial {
   scene: Scene
   material: ShaderMaterial
   toolBuffer: UniformBuffer
   renderMode = 0
   readonly isLineMesh: boolean // Fixed for this material's lifetime - see buildMaterial()

   static readonly vertexShader = `
   #define THIN_INSTANCES
   precision highp float;
   

   attribute vec3 position;
   attribute vec3 normal;

   attribute float filePosition;
   attribute vec3 pickColor;
   attribute float tool;
   attribute float feedRate;
   attribute float filePositionEnd;
   attribute float isPerimeter;
   attribute vec3 baseColor;

   uniform mat4 viewProjection;
   uniform mat4 worldView;
   uniform mat4 view;

   uniform float animationLength;
   uniform float currentPosition;
   uniform vec4 toolColors[20];
   uniform vec3 focusedPickColor;
   uniform float maxFeedRate;
   uniform float minFeedRate;
   uniform bool progressMode;
   uniform vec4 progressColor;
   uniform bool showSupports;
   uniform float utime;
   uniform int renderMode;

   uniform bool alphaMode;
   uniform vec3 minFeedColor;
   uniform vec3 maxFeedColor;
   uniform bool showTravels;
   uniform bool persistTravels;

   varying vec3 eye_normal;
   flat out vec3 vDiffColor;
   flat out float fIsPerimeter;
   flat out float bDiscard;
   flat out float fShow;
   flat out float focused;

 #include<instancesDeclaration>

   void main()
   {
      #include<instancesVertex>
  
      fIsPerimeter = isPerimeter;

      switch(renderMode){
            case 0: 
               vDiffColor = baseColor.rgb; 
            break; // use default diffuse color;
            case 1:
               if(tool < 255.0)
               {
                  vDiffColor = toolColors[int(tool)].rgb;
               }
               else
               {
                  vDiffColor = vec3(1,0,0); //Travel Color Make Configurable at some point
               }
            break;
            case 2:
               float m = (feedRate - minFeedRate) / (maxFeedRate - minFeedRate);
               vDiffColor = mix(minFeedColor, maxFeedColor, m);
               break;
            case 5:
               vDiffColor = pickColor.rgb;
               break;
         }

         fShow = currentPosition - filePosition;
         focused = 0.;

         if(focusedPickColor == pickColor && !(currentPosition >= filePosition && currentPosition <= filePositionEnd)) 
         {
            vDiffColor = vec3(1, 1, 1) - vDiffColor.rgb;
            focused = 1.;
         }
         else if (tool >= 254.0)  //Travel
         {
            if (!showTravels)
            {
               bDiscard = 1.;
            }
            else if (persistTravels)
            {
               if (fShow >= 0.0)
               {
                  vDiffColor = vec3(1.0, 0.0, 0.0);
               }
               else
               {
                  bDiscard = 1.;
               }
            }
            else if(fShow >= 0.0 && fShow < animationLength / 8.0)
            {
                  vDiffColor = mix(vec3(1.0, 0.0, 0.0), vec3(0.5,0.0,0.0), fShow / animationLength / 2.0);
            }
            else
            {
               bDiscard = 1.;
            }
         }
         else //Extrusion
         {
            if (fShow >= 0.0  && fShow < animationLength) 
            { 
               if(currentPosition < filePositionEnd){
                  // float animation = smoothstep(0.0, 1.0, fract(utime / 50.0));
                  float animation = sin(2.0 * 3.1415 * utime / 1000.0) * 0.5 + 0.5;
                  vDiffColor = mix(vec3(0, 0, 1), vec3(0,1,0), animation);
               }
               else 
               {
                  vDiffColor = mix(vec3(1, 1, 1) - vDiffColor.rgb, vDiffColor.rgb, fShow / animationLength);
               }
            }
            else if (fShow >= 0.0 && progressMode) 
            {
               vDiffColor = progressColor.rgb;
            }
            else if(fShow < 0.0 && !alphaMode && !progressMode)
            {
               bDiscard = 1.;
            }
         }

         //Final Results
         gl_Position = viewProjection * finalWorld *  vec4(position, 1.0);
         mat4 n =transpose(inverse(worldView * finalWorld));
         eye_normal = (n * (vec4(normal , 1.0) * vec4(position,1.)) ).xyz;
   }`

   static readonly fragmentShader = `
   precision highp float;
   #include<helperFunctions>

   const vec3 LIGHT_TOP_DIR = vec3(-0.4574957, 0.4574957, 0.7624929);
   const vec3 LIGHT_FRONT_DIR = vec3(0.0, 0.0, 1.0);
   
   // x = ambient, y = top diffuse, z = front diffuse, w = global
   const vec4 light_intensity = vec4(0.45, 0.7, 0.75, 0.75);
   varying vec3 eye_normal;

   uniform bool alphaMode;
   uniform bool progressMode;
   uniform float ghostAlpha;
   uniform bool useSpecular;

   flat in vec3 vDiffColor;
   flat in float fIsPerimeter;
   flat in float bDiscard;
   flat in float fShow;
   flat in float focused;
   const vec3 lowerBound = vec3(0.3,0.3,0.3);

   void main(){

         if( bDiscard > 0.0) {
            discard;
         }

         vec4 diffuseColor = vec4(vDiffColor, 1);

         if(focused > 0.)
         {
            diffuseColor.a = 1.0;
         }
         else
         {
            diffuseColor.a = fShow >= 0.0 || !alphaMode ? 0.99 : ghostAlpha;
         }

        #ifdef LINE_MESH
            if(fIsPerimeter < 1.0)
            {
               if(all(lessThan(diffuseColor.rgb,lowerBound.rgb))) {
                  diffuseColor = vec4(diffuseColor.rgb + lowerBound, diffuseColor.a);
               }
               else {
                  diffuseColor = vec4(diffuseColor.rgb - lowerBound, diffuseColor.a);
               }
            }
            else
            {
            diffuseColor = vec4(diffuseColor.rgb, diffuseColor.a);
            }
            gl_FragColor = diffuseColor;
         #else
            vec3 normal = normalize(eye_normal);
            float NdotL = abs(dot(normal, LIGHT_TOP_DIR));
            float intensity = light_intensity.x + NdotL * light_intensity.y;
            NdotL = abs(dot(normal, LIGHT_FRONT_DIR));
            intensity += NdotL * light_intensity.z;
            vec3 lit = diffuseColor.rgb * light_intensity.w * intensity;

            if (useSpecular) {
               // Camera looks down -Z in view space, so the direction to the eye is ~(0,0,1);
               // Blinn-Phong half-vector against each fixed light direction already used above
               vec3 viewDir = vec3(0.0, 0.0, 1.0);
               vec3 halfTop = normalize(LIGHT_TOP_DIR + viewDir);
               vec3 halfFront = normalize(LIGHT_FRONT_DIR + viewDir);
               float specular = pow(max(dot(normal, halfTop), 0.0), 32.0)
                  + pow(max(dot(normal, halfFront), 0.0), 32.0);
               lit += vec3(specular) * 0.5;
            }

            gl_FragColor = vec4(lit, diffuseColor.a);
         #endif
   }`

   constructor(scene: Scene, isLineMesh: boolean = false) {
      this.scene = scene
      this.isLineMesh = isLineMesh
      this.buildMaterial()
   }

   buildMaterial() {
      this.material = new ShaderMaterial(
         `line_shader`,
         this.scene,
         {
            vertexSource: LineShaderMaterial.vertexShader,
            fragmentSource: LineShaderMaterial.fragmentShader,
         },
         {
            attributes: [
               'position',
               'normal',
               'baseColor',
               'filePosition',
               'filePositionEnd',
               'pickColor',
               'tool',
               'feedRate',
               'isPerimeter',
            ],
            uniforms: [
               'world',
               'worldView',
               'worldViewProjection',
               'view',
               'projection',
               'viewProjection',
               'animationLength',
               'currentPosition',
               'renderMode',
               'toolColors',
               'focusedPickColor',
               'maxFeedRate',
               'minFeedRate',
               'alphaMode',
               'progressMode',
               'progressColor',
               'showSupports',
               'utime',
               'minFeedColor',
               'maxFeedColor',
               'showTravels',
               'persistTravels',
               'ghostAlpha',
               'useSpecular',
            ],
            // Every LineShaderMaterial instance compiles from the exact same vertex/fragment
            // source strings, so Babylon's Effect cache (keyed on source + defines) would
            // otherwise hand box/cylinder/line materials the SAME underlying compiled program -
            // and with it, the same uniform storage. lineMesh used to be a plain uniform, and
            // every material instance (box/cyl AND line) writing to "their own" lineMesh uniform
            // was actually racing to overwrite one shared value: whichever material happened to
            // bind most recently (e.g. during GPU picking or a shadow/depth pre-pass over
            // disabled meshes) silently won for every OTHER material sharing that effect too,
            // making "Force Line Rendering" intermittently render solid black (line geometry
            // rendered through the lit branch, which has no valid normals for a Lines mesh). A
            // define forces box/cyl and line materials into two genuinely separate compiled
            // effects, so there's no shared mutable state to race over.
            defines: this.isLineMesh ? ['#define LINE_MESH'] : [],
         },
      )

      this.material.alpha = 0.99
      this.material.forceDepthWrite = true

      //Set defaults
      this.material.onBindObservable.addOnce(() => {
         this.material
            .getEffect()
            ?.setFloat('animationLength', 5000)
            .setVector4('progressColor', new Vector4(0, 1, 0, 1))
            .setFloat3('minFeedColor', 0, 0, 1) // Matches the previous hardcoded blue->red gradient
            .setFloat3('maxFeedColor', 1, 0, 0)
            .setBool('showTravels', true)
            .setBool('persistTravels', false)
            .setFloat('ghostAlpha', 0.05) // Matches the previous hardcoded not-yet-printed alpha
            .setBool('useSpecular', false)
      })

      //Per loop
      let time = 0
      this.material.onBindObservable.add(() => {
         time += this.scene.getEngine().getDeltaTime()
         this.material.getEffect()?.setFloat('utime', time)

         //this.material.getEffect()?.setFloat4('progresscolor', 0, 1, 0, 1.0)
      })
   }

   updateRenderMode(mode: number) {
      this.renderMode = mode
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setInt('renderMode', mode)
      })
   }

   // Called on every single simulation/scrub step (unlike the other setters here, which only fire
   // on rare user settings changes) - unconditionally queuing a new addOnce every call is a real,
   // unbounded leak for any material whose mesh isn't currently the active mesh-mode variant (2 of
   // every 3 box/cylinder/line materials per chunk), since onBindObservable only fires for a
   // material actually bound to render a visible mesh: those queued callbacks pile up forever and
   // never fire, which is what made long simulation runs (or slider scrubbing) progressively
   // slower. The effect finishes compiling for all three variants at roughly the same time
   // regardless of which is currently visible, so the immediate path below covers the overwhelming
   // majority of calls after the first frame or two.
   // Called on every single simulation/scrub/pick-jump step (unlike the other setters here, which
   // only fire on rare user settings changes). A uniform write MUST happen via onBindObservable -
   // WebGL's gl.uniform* calls apply to whichever program is currently bound in the GL context,
   // not "the one this Effect object conceptually belongs to", so calling effect.setFloat()
   // outside of this material's own bind (which is what actually makes it the active program) can
   // silently write to the wrong program or no-op. isReady() only means "finished compiling", not
   // "currently bound" - an earlier version of this method used isReady() as an immediate-update
   // shortcut, which looked correct in isolation but broke playback/scrubbing/pick-to-jump
   // entirely, since the position uniform was no longer reliably reaching the shader at all.
   //
   // The real fix for the leak this used to have (every call queuing a new addOnce, which never
   // fires - and so never frees itself - for the 2 of every 3 box/cylinder/line materials per
   // chunk that aren't the currently active mesh-mode variant) is to coalesce: track whether a
   // callback is already queued for this material and, if so, just update the pending value it'll
   // read when it fires, instead of queuing another one. This bounds the leak to at most one
   // stale callback per inactive material (however long the app runs), not one per step.
   private pendingFilePosition: number | null = null
   private filePositionCallbackQueued = false

   updateCurrentFilePosition(position: number) {
      this.pendingFilePosition = position
      if (this.filePositionCallbackQueued) {
         return
      }
      this.filePositionCallbackQueued = true
      this.material.onBindObservable.addOnce(() => {
         this.filePositionCallbackQueued = false
         this.material.getEffect()?.setFloat('currentPosition', this.pendingFilePosition!)
      })
   }

   getMaterial() {
      if (this.material == null) {
         this.buildMaterial()
      }
      return this.material
   }

   updateToolColors(toolColors: number[]) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloatArray4('toolColors', toolColors)
      })
   }

   setPickColor(color: number[]) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat3('focusedPickColor', color[0] / 255, color[1] / 255, color[2] / 255)
      })
   }

   setMaxFeedRate(feedRate: number) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat('maxFeedRate', feedRate)
      })
   }

   setMinFeedRate(feedRate: number) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat('minFeedRate', feedRate)
      })
   }

   setAlphaMode(mode: boolean) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setBool('alphaMode', mode)
      })
   }

   setProgressMode(mode: boolean) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setBool('progressMode', mode)
      })
   }

   setProgressColor(color: number[]) {
      this.material.onBindObservable.addOnce(() => {
         this.material
            .getEffect()
            ?.setFloat4('progressColor', color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255)
      })
   }

   setMinFeedColor(rgb: [number, number, number]) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat3('minFeedColor', rgb[0], rgb[1], rgb[2])
      })
   }

   setMaxFeedColor(rgb: [number, number, number]) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat3('maxFeedColor', rgb[0], rgb[1], rgb[2])
      })
   }

   setShowTravels(visible: boolean) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setBool('showTravels', visible)
      })
   }

   setPersistTravels(persist: boolean) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setBool('persistTravels', persist)
      })
   }

   // percent: 1-100, the opacity of not-yet-printed lines while alphaMode ("ghosting") is on -
   // independent of alphaMode's own boolean toggle, which only decides whether ghosting happens
   // at all
   setTransparency(percent: number) {
      const alpha = Math.min(Math.max(percent, 0), 100) / 100
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setFloat('ghostAlpha', alpha)
      })
   }

   setUseSpecular(enabled: boolean) {
      this.material.onBindObservable.addOnce(() => {
         this.material.getEffect()?.setBool('useSpecular', enabled)
      })
   }

   showSupports(show: boolean) {
      // this.material.onBindObservable.addOnce(() => {
      //    this.material.getEffect()?.setBool('showSupports', show)
      // })
   }

   dispose() {
      if (this.material != null) {
         this.material.dispose()
         this.material = null
      }
   }
}
