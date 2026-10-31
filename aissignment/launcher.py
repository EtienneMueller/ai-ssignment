"""`aissignment` command: start JupyterLab (with this extension) in the current directory."""

import sys


def main() -> None:
    from jupyterlab.labapp import main as lab_main

    sys.exit(lab_main(argv=sys.argv[1:]))
