import Base from './base'
import ProcessorProperties from '../processorproperties'

// Minimal placeholder for a gCodeLines[] entry whose actual parsing/rendering already happened
// elsewhere (the WASM fast path parses the line and bakes its geometry straight into render
// buffers - see Processor.buildLightweightGCodeLines). The only things ever read back off
// gCodeLines entries are .line/.lineNumber/.filePosition/.lineType (GPU-picking readback,
// getGCodeInRange, updateByLineNumber) - carrying anything more (a real Move's position/feed
// rate/color/etc.) would just be wasted work and memory for data nothing consumes.
export default class IndexEntry extends Base {
   constructor(props: ProcessorProperties, line: string, lineType: string) {
      super(props, line)
      this.lineType = lineType
   }
}
