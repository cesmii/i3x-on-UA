# OPC UA specifications: not distributed here

This folder holds local copies of OPC Foundation specifications for development. **They are not part of this repository** (OPC Foundation copyright); the files are listed in `.gitignore`.

| File expected here | What it is | Where to get it |
|---|---|---|
| `OPC-10000-5-Part5-InformationModel.md` | OPC 10000-5 (OPC UA Part 5: Information Model) v1.05.06, the online HTML saved as text | <https://reference.opcfoundation.org/specs/OPC-10000-5/full> (save the page as text) |
| `OPC 40223 - UA Companion Specification for Pumps and Vacuum Pumps 1.00.pdf` | OPC 40223, Pumps and Vacuum Pumps v1.00 | Online: <https://reference.opcfoundation.org/Pumps/v100/docs/> · PDF: <https://opcfoundation.org/developer-tools/documents/> (free registration) |
| `OPC-40223-Pumps-1.00.txt` | A layout-preserving text extract of the Pumps PDF, for grep | `pdftotext -layout "<the PDF>" OPC-40223-Pumps-1.00.txt` |

The NodeSets these specifications define (MIT-licensed) are in `nodesets/standard/`; nothing in the build or runtime needs these documents.
