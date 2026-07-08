import { Base, Comment } from '../GCodeLines'
import Props from '../processorproperties'

const toolRegex = /^[T]-?[0-9]+/g

export default function (props: Props, line: string): Base {
   const match = line.match(toolRegex)
   // Lines starting with 'T' that aren't a tool select (e.g. Klipper macros like TIMELAPSE_TAKE_FRAME) fall through as comments
   if (!match) {
      return new Comment(props, line)
   }

   let toolIdx = Number(match[0].substring(1).trim())
   if (toolIdx < 0 || toolIdx >= props.tools.length) {
      toolIdx = 0
   }
   props.currentTool = props.tools[toolIdx]
   return new Comment(props, line)
}
