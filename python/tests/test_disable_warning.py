import io
import unittest
from contextlib import redirect_stderr

import loopiter
import loopiter.improvement as improvement
from loopiter import warn_ambiguous_improvement_disable


class AmbiguousDisableWarningTests(unittest.TestCase):
    def test_exported_and_warns_once_per_process(self):
        self.assertIn("warn_ambiguous_improvement_disable", loopiter.__all__)
        improvement._ambiguous_disable_warned = False
        captured = io.StringIO()
        with redirect_stderr(captured):
            warn_ambiguous_improvement_disable({"LOOPITER_DISABLE": "enabled"})
            warn_ambiguous_improvement_disable({"LOOPITER_DISABLE": "enable"})
        self.assertEqual(captured.getvalue().count("disables improvement work"), 1)
        improvement._ambiguous_disable_warned = False
