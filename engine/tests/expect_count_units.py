#!/usr/bin/env python3
import pathlib, sys, unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'mcp'))
import server

class CountTests(unittest.TestCase):
    def run_count(self, counts, **extra):
        calls=[]
        def run(*args):
            calls.append(args)
            count=counts.pop(0) if len(counts)>1 else counts[0]
            return {'ok':True,'version':2,'nodes':[
                {'ref':f'k2.{i}','role':'AXStaticText','title':'MTLSVideoP:test.mp4'} for i in range(count)]}
        args={'pid':17,'windowId':29,'query':'MTLSVideoP:test.mp4','count':2,**extra}
        with patch.object(server,'run_cu',side_effect=run), patch.object(server.time,'sleep') as sleep:
            result=server.call_tool('expect',args)
        return result,calls,sleep

    def test_ready_has_no_sleep(self):
        result,calls,sleep=self.run_count([2])
        self.assertFalse(result['isError'])
        self.assertEqual(calls[0],('snapshot','--pid','17','--window','29','--settle','0'))
        sleep.assert_not_called()

    def test_pending_repeats_reads_only(self):
        result,calls,_=self.run_count([1,2])
        self.assertFalse(result['isError'])
        self.assertEqual(len(calls),2)
        self.assertTrue(all(c[0]=='snapshot' for c in calls))

    def test_zero_is_valid(self):
        result,_,_=self.run_count([0],count=0)
        self.assertFalse(result['isError'])

    def test_timeout_zero_samples_once(self):
        result,calls,_=self.run_count([1],timeoutMs=0)
        self.assertTrue(result['isError'])
        self.assertEqual(len(calls),1)

    def test_invalid_count_or_scope_does_not_dispatch(self):
        for extra in ({'count':True},{'count':-1},{'windowId':None},{'query':''},{'value':'x'}):
            with patch.object(server,'run_cu') as run:
                r=server.call_tool('expect',{'pid':17,'windowId':29,'query':'clip','count':2,**extra})
                self.assertTrue(r['isError'])
                run.assert_not_called()

    def test_snapshot_failure_does_not_become_zero(self):
        with patch.object(server,'run_cu',return_value={'ok':False,'error':'window_gone'}):
            r=server.call_tool('expect',{'pid':17,'windowId':29,'query':'clip','count':0})
        self.assertTrue(r['isError'])

    def test_late_success_is_reported_as_timeout(self):
        with patch.object(server, 'run_cu', return_value={'ok': True, 'nodes': []}), \
             patch.object(server.time, 'monotonic', side_effect=[0, 2]):
            r=server.call_tool('expect',{'pid':17,'windowId':29,'query':'clip','count':0,'timeoutMs':100})
        self.assertTrue(r['isError'])

if __name__=='__main__': unittest.main()
