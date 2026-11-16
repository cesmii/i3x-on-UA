# OPC UA for Machinery (OPC 40001-1): not distributed here

This folder holds a local copy of the specification for development. **The specification is not part of this repository** (OPC Foundation copyright); the files are listed in `.gitignore`.

| File expected here | What it is | Where to get it |
|---|---|---|
| `OPC 40001-1 - UA CS for Machinery Part 1 - Basic Building Blocks 1.04.2.pdf` | OPC UA for Machinery, Part 1: Basic Building Blocks, v1.04.2 | Online: <https://reference.opcfoundation.org/Machinery/v104/docs/> · PDF: OPC Foundation document downloads, <https://opcfoundation.org/developer-tools/documents/> (free registration) |
| `OPC-40001-1-Machinery-1.04.2.txt` | A layout-preserving text extract of that PDF, for grep | Make it yourself: `pdftotext -layout "<the PDF>" OPC-40001-1-Machinery-1.04.2.txt` |

The Machinery NodeSet itself (MIT-licensed) is in `nodesets/standard/`; nothing in the build or runtime needs the PDF.
