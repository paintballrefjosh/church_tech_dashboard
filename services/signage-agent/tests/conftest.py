import os
import sys
import tempfile

# Every path the agent touches moves under a scratch folder (paths.ROOT is read at import).
ROOT = tempfile.mkdtemp(prefix="signage-root-")
os.environ["SIGNAGE_ROOT"] = ROOT
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
